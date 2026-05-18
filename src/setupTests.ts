import '@testing-library/jest-dom';

// jsdom does not implement URL.createObjectURL / revokeObjectURL.
// Stub them so vi.spyOn() in tests can wrap them.
if (typeof URL.createObjectURL === 'undefined') {
  Object.defineProperty(URL, 'createObjectURL', {
    value: () => 'blob:mock',
    writable: true,
    configurable: true,
  });
}
if (typeof URL.revokeObjectURL === 'undefined') {
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: () => {},
    writable: true,
    configurable: true,
  });
}
