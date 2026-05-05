import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export default defineSchema({
  passkeys: defineTable({
    credentialId: v.string(),
    publicKey: v.string(),
    counter: v.number(),
    transports: v.optional(v.array(v.string())),
    createdAt: v.number(),
  }).index('by_credential_id', ['credentialId']),

  challenges: defineTable({
    challenge: v.string(),
    kind: v.union(v.literal('registration'), v.literal('authentication')),
    origin: v.string(),
    rpId: v.string(),
    expiresAt: v.number(),
  }).index('by_challenge', ['challenge']),

  sessions: defineTable({
    token: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  }).index('by_token', ['token']),

  items: defineTable({
    sku: v.string(),
    brand: v.string(),
    location: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index('by_created_at', ['createdAt'])
    .index('by_sku', ['sku']),
})
