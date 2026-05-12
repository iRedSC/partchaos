import { useEffect, useRef, useState } from 'react'
import { ScanBarcodeIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

type BarcodeDetectorResult = {
  rawValue: string
}

type BarcodeDetectorInstance = {
  detect: (source: HTMLVideoElement) => Promise<BarcodeDetectorResult[]>
}

type BarcodeDetectorConstructor = new () => BarcodeDetectorInstance

type BarcodeWindow = Window & {
  BarcodeDetector?: BarcodeDetectorConstructor
}

type MobileBarcodeScannerModalProps = {
  onScan: (barcode: string) => void
}

export function MobileBarcodeScannerModal({ onScan }: MobileBarcodeScannerModalProps) {
  const [open, setOpen] = useState(false)
  const [holdingScan, setHoldingScan] = useState(false)
  const [status, setStatus] = useState('Camera preview starts when this test scanner opens.')
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const detectorRef = useRef<BarcodeDetectorInstance | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const scanActiveRef = useRef(false)
  const detectingRef = useRef(false)
  const scanCompleteRef = useRef(false)

  useEffect(() => {
    if (!open) {
      stopScanLoop()
      stopCamera()
      return
    }

    let cancelled = false

    async function startPreview() {
      scanCompleteRef.current = false
      detectorRef.current = null
      setStatus('Starting camera preview...')

      const Detector = (window as BarcodeWindow).BarcodeDetector

      if (!Detector) {
        setStatus('Barcode detection is not available in this browser.')
      } else {
        detectorRef.current = new Detector()
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('Camera access is not available in this browser.')
        return
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
          },
          audio: false,
        })

        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }

        streamRef.current = stream

        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }

        setStatus(
          detectorRef.current
            ? 'Hold the scan button while the barcode is visible.'
            : 'Camera preview is available, but this browser cannot detect barcodes.',
        )
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not start the camera.')
      }
    }

    void startPreview()

    return () => {
      cancelled = true
      stopScanLoop()
      stopCamera()
    }
  }, [open])

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }

  function stopScanLoop() {
    scanActiveRef.current = false
    detectingRef.current = false
    setHoldingScan(false)

    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = null
    }
  }

  async function scanFrame() {
    if (!scanActiveRef.current || scanCompleteRef.current) {
      return
    }

    const video = videoRef.current
    const detector = detectorRef.current

    if (video && detector && !detectingRef.current && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      detectingRef.current = true

      try {
        const results = await detector.detect(video)
        const barcode = results.find((result) => result.rawValue.trim())

        if (barcode) {
          scanCompleteRef.current = true
          stopScanLoop()
          onScan(barcode.rawValue)
          setOpen(false)
          return
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : 'Could not scan this frame.')
      } finally {
        detectingRef.current = false
      }
    }

    animationFrameRef.current = window.requestAnimationFrame(scanFrame)
  }

  function startHoldScan() {
    if (scanCompleteRef.current) {
      return
    }

    if (!detectorRef.current) {
      setStatus('Barcode detection is not available in this browser.')
      return
    }

    scanActiveRef.current = true
    setHoldingScan(true)
    setStatus('Scanning while you hold the button...')
    animationFrameRef.current = window.requestAnimationFrame(scanFrame)
  }

  function endHoldScan() {
    if (!scanActiveRef.current) {
      return
    }

    stopScanLoop()

    if (open && !scanCompleteRef.current) {
      setStatus('Hold the scan button while the barcode is visible.')
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="icon" className="sm:hidden" aria-label="Scan barcode">
          <ScanBarcodeIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-5 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Barcode Scanner</DialogTitle>
          <DialogDescription>
            Test feature. Preview the camera, then hold the button to scan.
          </DialogDescription>
        </DialogHeader>

        <div className="bg-muted relative aspect-[3/4] overflow-hidden rounded-lg border">
          <video
            ref={videoRef}
            className="h-full w-full object-cover"
            muted
            playsInline
            aria-label="Barcode scanner camera preview"
          />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-24 -translate-y-1/2 rounded-md border-2 border-white/80 shadow-[0_0_0_999px_rgba(0,0,0,0.35)]" />
        </div>

        <p className="text-muted-foreground min-h-5 text-sm" role="status">
          {status}
        </p>

        <DialogFooter>
          <Button
            type="button"
            className="h-12 w-full touch-none"
            disabled={!detectorRef.current}
            onPointerDown={startHoldScan}
            onPointerUp={endHoldScan}
            onPointerLeave={endHoldScan}
            onPointerCancel={endHoldScan}
            onKeyDown={(event) => {
              if (event.repeat || (event.key !== ' ' && event.key !== 'Enter')) {
                return
              }

              startHoldScan()
            }}
            onKeyUp={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                endHoldScan()
              }
            }}
          >
            {holdingScan ? 'Scanning...' : 'Hold to scan'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
