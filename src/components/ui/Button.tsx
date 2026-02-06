import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  showChevron?: boolean;
  children: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    'bg-crx-green text-white hover:bg-crx-green-hover active:bg-crx-green-hover shadow-sm',
  secondary:
    'bg-white text-nav-dark border border-gray-200 hover:bg-gray-50 active:bg-gray-100',
  ghost:
    'text-secondary hover:bg-gray-100 active:bg-gray-200',
  danger:
    'bg-red-600 text-white hover:bg-red-700 active:bg-red-800 shadow-sm',
};

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm gap-1.5',
  md: 'px-4 py-2 text-sm gap-2',
  lg: 'px-5 py-2.5 text-base gap-2',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      showChevron,
      children,
      className = '',
      disabled,
      ...props
    },
    ref
  ) => {
    const isChevron = showChevron ?? variant === 'primary';

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`
          inline-flex items-center justify-center font-medium rounded-lg
          transition-all duration-150 ease-in-out
          disabled:opacity-50 disabled:cursor-not-allowed
          ${variantClasses[variant]}
          ${sizeClasses[size]}
          ${className}
        `}
        {...props}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin" />}
        {!loading && icon}
        <span>{children}</span>
        {isChevron && !loading && <ChevronRight className="w-4 h-4" />}
      </button>
    );
  }
);

Button.displayName = 'Button';
export default Button;
