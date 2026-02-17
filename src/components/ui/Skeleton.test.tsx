import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Skeleton, { SkeletonCard, SkeletonTable } from './Skeleton';

describe('Skeleton', () => {
  it('renders a div with animate-pulse', () => {
    const { container } = render(<Skeleton />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('animate-pulse');
    expect(div.className).toContain('bg-gray-200');
  });

  it('applies custom className', () => {
    const { container } = render(<Skeleton className="h-4 w-full" />);
    const div = container.firstChild as HTMLElement;
    expect(div.className).toContain('h-4');
    expect(div.className).toContain('w-full');
  });
});

describe('SkeletonCard', () => {
  it('renders a card-like skeleton with 3 inner skeletons', () => {
    const { container } = render(<SkeletonCard />);
    const pulseDivs = container.querySelectorAll('.animate-pulse');
    expect(pulseDivs.length).toBe(3);
  });

  it('has card styling', () => {
    const { container } = render(<SkeletonCard />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('bg-white');
    expect(card.className).toContain('rounded-xl');
  });
});

describe('SkeletonTable', () => {
  it('renders 5 rows by default', () => {
    const { container } = render(<SkeletonTable />);
    // Each row has 4 Skeleton divs, plus 1 header Skeleton = 21 total pulse elements
    const rows = container.querySelectorAll('.space-y-3 > div');
    expect(rows.length).toBe(5);
  });

  it('renders custom number of rows', () => {
    const { container } = render(<SkeletonTable rows={3} />);
    const rows = container.querySelectorAll('.space-y-3 > div');
    expect(rows.length).toBe(3);
  });

  it('has card styling', () => {
    const { container } = render(<SkeletonTable />);
    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('bg-white');
    expect(card.className).toContain('rounded-xl');
  });
});
