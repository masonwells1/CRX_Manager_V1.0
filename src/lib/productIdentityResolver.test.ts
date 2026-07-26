import { describe, expect, it } from 'vitest';
import {
  resolveExactProductIdentity,
  resolveFuzzyProductIdentity,
} from './productIdentityResolver';

const products = [
  { id: 'a', product_name: 'Same Name', sku: 'SKU-A', is_active: true },
  { id: 'b', product_name: 'Same Name', sku: 'SKU-B', is_active: true },
  { id: 'c', product_name: 'Unique Name', sku: 'SKU-C', is_active: true },
  { id: 'd', product_name: 'Inactive', sku: 'OLD', is_active: false },
];

describe('resolveExactProductIdentity', () => {
  it('fails closed for ambiguous same-name siblings', () => {
    const resolution = resolveExactProductIdentity(' same   name ', products);
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status === 'ambiguous') {
      expect(resolution.candidates.map(({ id }) => id)).toEqual(['a', 'b']);
    }
  });

  it('resolves a unique SKU', () => {
    expect(resolveExactProductIdentity('sku-a', products)).toMatchObject({
      status: 'unique',
      product: { id: 'a' },
    });
  });

  it('resolves a unique exact name', () => {
    expect(resolveExactProductIdentity(' unique   name ', products)).toMatchObject({
      status: 'unique',
      product: { id: 'c' },
    });
  });

  it('fails closed when one Product name equals another Product SKU', () => {
    const resolution = resolveExactProductIdentity('X', [
      { id: 'name-match', product_name: 'X', sku: 'NAME-SKU', is_active: true },
      { id: 'sku-match', product_name: 'Other', sku: 'X', is_active: true },
    ]);
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status === 'ambiguous') {
      expect(resolution.candidates.map(({ id }) => id)).toEqual(['name-match', 'sku-match']);
    }
  });

  it('deduplicates a Product matched by both fields by immutable UUID', () => {
    expect(resolveExactProductIdentity('X', [
      { id: 'same-id', product_name: 'X', sku: 'X', is_active: true },
    ])).toMatchObject({
      status: 'unique',
      product: { id: 'same-id' },
    });
  });

  it('ignores inactive Products and reports missing identities', () => {
    expect(resolveExactProductIdentity('OLD', products)).toEqual({ status: 'missing', product: null });
    expect(resolveExactProductIdentity('unknown', products)).toEqual({ status: 'missing', product: null });
  });
});

describe('resolveFuzzyProductIdentity', () => {
  it('keeps exact same-name siblings unresolved', () => {
    expect(resolveFuzzyProductIdentity('Same Name', products)).toEqual({ product: null, score: 0 });
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
