import SearchableSelect from '../ui/SearchableSelect';
import {
  ProductOptionDetails,
  productOptionLabel,
  type ProductOptionPresentationModel,
} from '../products/ProductOptionPresentation';

export function JobChemicalProductPicker({
  products,
  value,
  onChange,
  disabled = false,
}: {
  products: ProductOptionPresentationModel[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = products.find((product) => product.id === value);
  return (
    <>
      <SearchableSelect
        options={products.map((product) => ({
          value: product.id,
          label: productOptionLabel(product),
        }))}
        value={value}
        onChange={onChange}
        disabled={disabled}
        placeholder="Select product..."
      />
      {selected && <ProductOptionDetails product={selected} />}
    </>
  );
}
