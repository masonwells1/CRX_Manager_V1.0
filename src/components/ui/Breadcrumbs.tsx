import { ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface BreadcrumbItem {
  label: string;
  href?: string;
}

interface BreadcrumbsProps {
  items: BreadcrumbItem[];
}

export default function Breadcrumbs({ items }: BreadcrumbsProps) {
  const navigate = useNavigate();

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-secondary">
      {items.map((item, i) => {
        const isLast = i === items.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}
            {isLast || !item.href ? (
              <span className="font-medium text-primary truncate max-w-[200px]">{item.label}</span>
            ) : (
              <button
                onClick={() => navigate(item.href!)}
                className="text-crx-green hover:underline hover:text-crx-green-dark transition-colors"
              >
                {item.label}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
