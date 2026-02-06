interface SplitHeadingProps {
  title: string;
  accent: string;
  size?: 'lg' | 'xl' | '2xl';
}

const sizeClasses = {
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
};

export default function SplitHeading({ title, accent, size = '2xl' }: SplitHeadingProps) {
  return (
    <h1 className={`${sizeClasses[size]} font-semibold font-heading text-nav-dark`}>
      {title} <span className="split-heading-accent">{accent}</span>
    </h1>
  );
}
