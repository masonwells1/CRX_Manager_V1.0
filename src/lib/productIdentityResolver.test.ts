import { describe, expect, it } from 'vitest';
import {
  resolveExactProductIdentity,
  resolveFuzzyProductIdentity,
} from './productIdentityResolver';

const products = [
  { id: 'a', product_name: 'Same Name', sku: 'SKU-A', is_active: true },
  { id: 'b', product_name: 'Same Name', sku: 'SKU-B', is_active: true },
  { id: 'c', product_name: 'SKU-A', sku: 'SKU-C', is_active: true },
  { id: 'd', product_name: 'Inactive', sku: 'OLD', is_active: false },
];

describe('resolveExactProductIdentity', () => {
  it('fails closed for ambiguous same-name siblings', () => {
    expect(resolveExactProductIdentity(' same   name ', products)).toEqual({
      status: 'ambiguous',
      product: null,
    });
  });

  it('keeps a unique SKU valid across same-name siblings and name collisions', () => {
    expect(resolveExactProductIdentity('sku-a', products)).toMatchObject({
      status: 'unique',
      product: { id: 'a' },
    });
  });

  it('deduplicates matches by immutable Product UUID', () => {
    expect(resolveExactProductIdentity('SKU-B', [...products, products[1]])).toMatchObject({
      status: 'unique',
      product: { id: 'b' },
    });
  });

  it('ignores inactive Products and reports missing identities', () => {
    expect(resolveExactProductIdentity('OLD', products)).toEqual({ status: 'missing', product: null });
    expect(resolveExactProductIdentity('unknown', products)).toEqual({ status: 'missing', product: null });
  });
});

describe('resolveFuzzyProductIdentity', () => {
  it('keeps exact same-name siblings unresolved', () => {
    expect(resolveFuzzyProductIdentity('Same Name', products)).toEqual({
      product: null,
      score: 0,
    });
  });

  it('keeps tied fuzzy siblings unresolved', () => {
    expect(resolveFuzzyProductIdentity('SimilarProduc', [
      { id: 'left', product_name: 'Similar Product A', is_active: true },
      { id: 'right', product_name: 'Similar Product B', is_active: true },
    ])).toEqual({ product: null, score: 0 });
  });

  it('accepts one unique fuzzy result and preserves its UUID', () => {
    expect(resolveFuzzyProductIdentity('DistinctProduc', [
      { id: 'chosen-uuid', product_name: 'Distinct Product', is_active: true },
      { id: 'other-uuid', product_name: 'Unrelated Material', is_active: true },
    ])).toMatchObject({
      product: { id: 'chosen-uuid' },
    });
  });
});
