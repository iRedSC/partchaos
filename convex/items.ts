import { v } from 'convex/values'

import type { MutationCtx, QueryCtx } from './_generated/server'
import { mutation, query } from './_generated/server'

async function requireSession(ctx: QueryCtx | MutationCtx, token: string) {
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique()

  if (!session || session.expiresAt <= Date.now()) {
    throw new Error('Sign in with a passkey to continue.')
  }
}

export const list = query({
  args: { sessionToken: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken)

    return await ctx.db.query('items').withIndex('by_created_at').order('desc').take(25)
  },
})

export const add = mutation({
  args: { sessionToken: v.string(), text: v.string() },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken)

    const text = args.text.trim()
    if (!text) {
      throw new Error('Add a little text first.')
    }

    await ctx.db.insert('items', {
      text,
      createdAt: Date.now(),
    })
  },
})

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id('items') },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken)
    await ctx.db.delete(args.id)
  },
})
