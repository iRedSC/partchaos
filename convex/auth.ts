import { v } from 'convex/values'

import { query } from './_generated/server'

export const passkeyStatus = query({
  args: {},
  handler: async (ctx) => {
    const passkeys = await ctx.db.query('passkeys').collect()

    return {
      passkeyCount: passkeys.length,
      hasPasskey: passkeys.length > 0,
    }
  },
})

export const sessionStatus = query({
  args: { sessionToken: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!args.sessionToken) {
      return { authenticated: false }
    }

    const session = await ctx.db
      .query('sessions')
      .withIndex('by_token', (q) => q.eq('token', args.sessionToken as string))
      .unique()

    return {
      authenticated: Boolean(session && session.expiresAt > Date.now()),
    }
  },
})
