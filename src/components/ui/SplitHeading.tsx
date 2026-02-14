interface SplitHeadingProps {
  title: string;
  accent: string;
  size?: 'lg' | 'xl' | '2xl';
  children?: React.ReactNode;
}

const sizeClasses = {
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
};

export default function SplitHeading({ title, accent, size = '2xl', children }: SplitHeadingProps) {
  if (children) {
    return (
      <div className="flex items-center justify-between gap-4">
        <h1 className={`${sizeClasses[size]} font-semibold font-heading text-nav-dark`}>
          {title} <span className="split-heading-accent">{accent}</span>
        </h1>
        <div className="flex items-center gap-2">{children}</div>
      </div>
    );
  }
  return (
    <h1 className={`${sizeClasses[size]} font-semibold font-heading text-nav-dark`}>
      {title} <span className="split-heading-accent">{accent}</span>
    </h1>
  );
}
