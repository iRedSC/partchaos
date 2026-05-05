import { v } from 'convex/values'

import { internalMutation, internalQuery } from './_generated/server'

const challengeKind = v.union(v.literal('registration'), v.literal('authentication'))

export const listPasskeys = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query('passkeys').collect()
  },
})

export const getPasskeyByCredentialId = internalQuery({
  args: { credentialId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('passkeys')
      .withIndex('by_credential_id', (q) => q.eq('credentialId', args.credentialId))
      .unique()
  },
})

export const savePasskey = internalMutation({
  args: {
    credentialId: v.string(),
    publicKey: v.string(),
    counter: v.number(),
    transports: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('passkeys')
      .withIndex('by_credential_id', (q) => q.eq('credentialId', args.credentialId))
      .unique()

    if (existing) {
      await ctx.db.patch(existing._id, {
        publicKey: args.publicKey,
        counter: args.counter,
        transports: args.transports,
      })
      return existing._id
    }

    return await ctx.db.insert('passkeys', {
      ...args,
      createdAt: Date.now(),
    })
  },
})

export const updatePasskeyCounter = internalMutation({
  args: { credentialId: v.string(), counter: v.number() },
  handler: async (ctx, args) => {
    const passkey = await ctx.db
      .query('passkeys')
      .withIndex('by_credential_id', (q) => q.eq('credentialId', args.credentialId))
      .unique()

    if (!passkey) {
      throw new Error('Passkey not found.')
    }

    await ctx.db.patch(passkey._id, { counter: args.counter })
  },
})

export const saveChallenge = internalMutation({
  args: {
    challenge: v.string(),
    kind: challengeKind,
    origin: v.string(),
    rpId: v.string(),
    expiresAt: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert('challenges', args)
  },
})

export const getChallenge = internalQuery({
  args: { challenge: v.string(), kind: challengeKind },
  handler: async (ctx, args) => {
    const challenge = await ctx.db
      .query('challenges')
      .withIndex('by_challenge', (q) => q.eq('challenge', args.challenge))
      .unique()

    if (!challenge || challenge.kind !== args.kind || challenge.expiresAt < Date.now()) {
      return null
    }

    return challenge
  },
})

export const consumeChallenge = internalMutation({
  args: { challenge: v.string(), kind: challengeKind },
  handler: async (ctx, args) => {
    const challenge = await ctx.db
      .query('challenges')
      .withIndex('by_challenge', (q) => q.eq('challenge', args.challenge))
      .unique()

    if (challenge && challenge.kind === args.kind) {
      await ctx.db.delete(challenge._id)
    }
  },
})

export const createSession = internalMutation({
  args: { token: v.string(), expiresAt: v.number() },
  handler: async (ctx, args) => {
    await ctx.db.insert('sessions', {
      token: args.token,
      createdAt: Date.now(),
      expiresAt: args.expiresAt,
    })
  },
})
