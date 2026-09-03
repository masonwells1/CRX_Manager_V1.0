// A migration that creates SECURITY DEFINER code must visibly withdraw the
// repository's default anon EXECUTE grant. Keep this parse deliberately narrow:
// it is a proof-producer precondition, so an unfamiliar spelling fails closed.
export const CREATE_FN_ANY = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\s*\.\s*)?"?(\w+)"?\s*\(/gi;

export function securityDefinerMissingAnonRevokes(sql) {
  const declarations = [...sql.matchAll(CREATE_FN_ANY)];
  const missing = [];
  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const end = declarations[index + 1]?.index ?? sql.length;
    const definition = sql.slice(declaration.index, end);
    if (!/\bSECURITY\s+DEFINER\b/i.test(definition)) continue;
    const name = declaration[1];
    const revoke = new RegExp(
      `REVOKE\\s+(?:ALL(?:\\s+PRIVILEGES)?|EXECUTE)\\s+ON\\s+FUNCTION\\s+(?:"?public"?\\s*\\.\\s*)?"?${name}"?\\s*\\([^;]*?\\)\\s+FROM\\s+([^;]+);`,
      'ig',
    );
    if (![...sql.matchAll(revoke)].some((match) => /\banon\b/i.test(match[1]))) missing.push(name);
  }
  return [...new Set(missing)];
}
