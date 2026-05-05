"use node"

import { randomBytes } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { v } from 'convex/values'

import { internal } from './_generated/api'
import { action } from './_generated/server'

const challengeTtlMs = 5 * 60 * 1000
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000

function configuredOrigin(clientOrigin: string) {
  return process.env.SITE_ORIGIN?.trim() || clientOrigin
}

function rpIdForOrigin(origin: string) {
  return new URL(origin).hostname
}

function storedTransports(transports: string[] | undefined) {
  return transports as AuthenticatorTransportFuture[] | undefined
}

function requireUniversalPassword(password: string) {
  const expected = process.env.UNIVERSAL_PASSWORD

  if (!expected) {
    throw new Error('Set UNIVERSAL_PASSWORD in Convex before creating passkeys.')
  }

  if (password !== expected) {
    throw new Error('That password does not match the configured universal password.')
  }
}

export const startRegistration = action({
  args: { password: v.string(), origin: v.string() },
  handler: async (ctx, args) => {
    requireUniversalPassword(args.password)

    const origin = configuredOrigin(args.origin)
    const rpID = rpIdForOrigin(origin)
    const existingPasskeys = await ctx.runQuery(internal.authData.listPasskeys)
    const options = await generateRegistrationOptions({
      rpName: 'partchaos',
      rpID,
      userID: new TextEncoder().encode('partchaos'),
      userName: 'partchaos',
      userDisplayName: 'partchaos',
      attestationType: 'none',
      excludeCredentials: existingPasskeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: storedTransports(passkey.transports),
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
    })

    await ctx.runMutation(internal.authData.saveChallenge, {
      challenge: options.challenge,
      kind: 'registration',
      origin,
      rpId: rpID,
      expiresAt: Date.now() + challengeTtlMs,
    })

    return { options, challenge: options.challenge }
  },
})

export const finishRegistration = action({
  args: { challenge: v.string(), response: v.any() },
  handler: async (ctx, args) => {
    const challenge = await ctx.runQuery(internal.authData.getChallenge, {
      challenge: args.challenge,
      kind: 'registration',
    })

    if (!challenge) {
      throw new Error('Registration challenge expired. Try creating the passkey again.')
    }

    const verification = await verifyRegistrationResponse({
      response: args.response as RegistrationResponseJSON,
      expectedChallenge: args.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      requireUserVerification: false,
    })

    await ctx.runMutation(internal.authData.consumeChallenge, {
      challenge: args.challenge,
      kind: 'registration',
    })

    if (!verification.verified) {
      throw new Error('The passkey could not be verified.')
    }

    const { credential } = verification.registrationInfo

    await ctx.runMutation(internal.authData.savePasskey, {
      credentialId: credential.id,
      publicKey: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
    })

    return { ok: true }
  },
})

export const startAuthentication = action({
  args: { origin: v.string() },
  handler: async (ctx, args) => {
    const passkeys = await ctx.runQuery(internal.authData.listPasskeys)

    if (passkeys.length === 0) {
      throw new Error('Create a passkey with the universal password first.')
    }

    const origin = configuredOrigin(args.origin)
    const rpID = rpIdForOrigin(origin)
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: storedTransports(passkey.transports),
      })),
      userVerification: 'preferred',
    })

    await ctx.runMutation(internal.authData.saveChallenge, {
      challenge: options.challenge,
      kind: 'authentication',
      origin,
      rpId: rpID,
      expiresAt: Date.now() + challengeTtlMs,
    })

    return { options, challenge: options.challenge }
  },
})

export const finishAuthentication = action({
  args: { challenge: v.string(), response: v.any() },
  handler: async (ctx, args) => {
    const challenge = await ctx.runQuery(internal.authData.getChallenge, {
      challenge: args.challenge,
      kind: 'authentication',
    })

    if (!challenge) {
      throw new Error('Sign-in challenge expired. Try again.')
    }

    const response = args.response as AuthenticationResponseJSON
    const passkey = await ctx.runQuery(internal.authData.getPasskeyByCredentialId, {
      credentialId: response.id,
    })

    if (!passkey) {
      throw new Error('This passkey is not registered for partchaos.')
    }

    const credential: WebAuthnCredential = {
      id: passkey.credentialId,
      publicKey: isoBase64URL.toBuffer(passkey.publicKey),
      counter: passkey.counter,
      transports: storedTransports(passkey.transports),
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: args.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpId,
      credential,
      requireUserVerification: false,
    })

    await ctx.runMutation(internal.authData.consumeChallenge, {
      challenge: args.challenge,
      kind: 'authentication',
    })

    if (!verification.verified) {
      throw new Error('The passkey sign-in could not be verified.')
    }

    await ctx.runMutation(internal.authData.updatePasskeyCounter, {
      credentialId: passkey.credentialId,
      counter: verification.authenticationInfo.newCounter,
    })

    const sessionToken = randomBytes(32).toString('base64url')

    await ctx.runMutation(internal.authData.createSession, {
      token: sessionToken,
      expiresAt: Date.now() + sessionTtlMs,
    })

    return { sessionToken }
  },
})
