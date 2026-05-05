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

    return await ctx.db.query('items').withIndex('by_created_at').order('desc').take(1000)
  },
})

export const upsertMany = mutation({
  args: {
    sessionToken: v.string(),
    products: v.array(
      v.object({
        sku: v.string(),
        brand: v.string(),
        location: v.string(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken)

    const now = Date.now()
    const products = args.products
      .map((product) => ({
        sku: product.sku.trim(),
        brand: product.brand.trim(),
        location: product.location.trim(),
      }))
      .filter((product) => product.sku)

    if (products.length === 0) {
      throw new Error('Add at least one SKU first.')
    }

    for (const product of products) {
      const existing = await ctx.db
        .query('items')
        .withIndex('by_sku', (q) => q.eq('sku', product.sku))
        .unique()

      if (existing) {
        await ctx.db.patch(existing._id, {
          brand: product.brand,
          location: product.location,
          updatedAt: now,
        })
        continue
      }

      await ctx.db.insert('items', {
        ...product,
        createdAt: now,
        updatedAt: now,
      })
    }
  },
})

export const remove = mutation({
  args: { sessionToken: v.string(), id: v.id('items') },
  handler: async (ctx, args) => {
    await requireSession(ctx, args.sessionToken)
    await ctx.db.delete(args.id)
  },
})
