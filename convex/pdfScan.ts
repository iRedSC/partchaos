"use node"

import { v } from 'convex/values'

import { internal } from './_generated/api'
import { action } from './_generated/server'

type OpenAiContent = {
  type?: string
  text?: string
}

type OpenAiOutput = {
  content?: OpenAiContent[]
}

type OpenAiResponse = {
  output_text?: string
  output?: OpenAiOutput[]
}

type ParsedLineItem = {
  sku?: string
  partNumber?: string
}

function extractResponseText(response: OpenAiResponse) {
  if (typeof response.output_text === 'string') {
    return response.output_text
  }

  return (
    response.output
      ?.flatMap((output) => output.content ?? [])
      .map((content) => content.text)
      .find((text): text is string => Boolean(text)) ?? ''
  )
}

function parseLineItems(text: string) {
  const parsed = JSON.parse(text) as { items?: ParsedLineItem[] }
  const seen = new Set<string>()

  return (parsed.items ?? [])
    .map((item) => (item.sku || item.partNumber || '').trim())
    .filter((sku) => {
      const key = sku.toLowerCase()

      if (!sku || seen.has(key)) {
        return false
      }

      seen.add(key)
      return true
    })
}

export const scanPurchaseOrder = action({
  args: {
    sessionToken: v.string(),
    fileName: v.string(),
    fileDataUrl: v.string(),
    brand: v.string(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.runQuery(internal.authData.getValidSession, {
      token: args.sessionToken,
    })

    if (!session) {
      throw new Error('Sign in with a passkey to continue.')
    }

    const apiKey = process.env.OPENAI_API_KEY

    if (!apiKey) {
      throw new Error('Set OPENAI_API_KEY in Convex before scanning purchase orders.')
    }

    const brand = args.brand.trim()

    if (!brand) {
      throw new Error('Enter the purchase order brand before scanning.')
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-5.4-mini',
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text:
                  'Extract purchase order line items from PDFs. Return only SKU or manufacturer part numbers for actual purchasable line items. Ignore totals, notes, shipping, taxes, headings, quantities, prices, and duplicate rows.',
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: `The purchase order brand is "${brand}". Extract every line item SKU or part number from the attached PDF.`,
              },
              {
                type: 'input_file',
                filename: args.fileName || 'purchase-order.pdf',
                file_data: args.fileDataUrl,
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'purchase_order_line_items',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      sku: {
                        type: 'string',
                        description: 'The SKU if the document labels one, otherwise an empty string.',
                      },
                      partNumber: {
                        type: 'string',
                        description:
                          'The manufacturer part number if no SKU is present, otherwise an empty string.',
                      },
                    },
                    required: ['sku', 'partNumber'],
                  },
                },
              },
              required: ['items'],
            },
          },
        },
      }),
    })

    if (!response.ok) {
      const details = await response.text()
      throw new Error(`OpenAI PDF scan failed: ${details || response.statusText}`)
    }

    const data = (await response.json()) as OpenAiResponse
    const skus = parseLineItems(extractResponseText(data))

    return {
      products: skus.map((sku) => ({
        sku,
        brand,
        location: '',
      })),
    }
  },
})
