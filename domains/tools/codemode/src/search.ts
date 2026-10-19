/**
 * Ranking tools for `searchTools(query)`: BM25 over three fields of each tool, its name (weighted most), its
 * description, and its namespace's description (weighted least, so a word every tool of a namespace shares through it
 * neither drowns a word in a name nor counts as rare), as pi ranks them by name, description, and server.
 */

export interface Searchable {
  readonly name: string;
  readonly description: string;
  /** Its namespace's description, when it has one. */
  readonly context?: string;
}

const K1 = 1.2;
const B = 0.75;
const WEIGHTS = { name: 3, description: 1, context: 0.5 } as const;
type Field = keyof typeof WEIGHTS;

/** Lowercase words, split at case changes and `_`/`-`, so `browser_snapshot` and `getModelOfType` match their parts. */
export const terms = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];

/** Words a query says in passing ("click a button on the page"), which would rank tools by how much prose they have. */
const STOPWORDS = new Set(
  "a an and are as at be by can do for from get how i in into is it its me my of on or our over should that the their them then there these this to up use using want we what when where which will with you your".split(
    " ",
  ),
);

/** The documents of `items` ranked for `query`, best first; those matching no word are left out. */
export function rank<T extends Searchable>(items: readonly T[], query: string): T[] {
  const all = [...new Set(terms(query))];
  const meant = all.filter((word) => !STOPWORDS.has(word));
  const words = meant.length === 0 ? all : meant;
  if (words.length === 0) return [];
  const fields = (item: T): Record<Field, string[]> => ({ name: terms(item.name), description: terms(item.description), context: terms(item.context ?? "") });
  const documents = items.map((item) => {
    const bags = fields(item);
    const counts = Object.fromEntries(
      (Object.keys(bags) as Field[]).map((field) => {
        const count = new Map<string, number>();
        for (const word of bags[field]) count.set(word, (count.get(word) ?? 0) + 1);
        return [field, count];
      }),
    ) as Record<Field, Map<string, number>>;
    return { item, counts, lengths: { name: bags.name.length, description: bags.description.length, context: bags.context.length } };
  });
  const average = (field: Field) => documents.reduce((sum, document) => sum + document.lengths[field], 0) / Math.max(documents.length, 1);
  const averages = { name: average("name"), description: average("description"), context: average("context") };
  // How rare a word is among the tools' own names and descriptions; a word only namespaces say, among those.
  const idf = new Map(
    words.map((word) => {
      const own = documents.filter((document) => document.counts.name.has(word) || document.counts.description.has(word)).length;
      const having = own > 0 ? own : documents.filter((document) => document.counts.context.has(word)).length;
      return [word, Math.log(1 + (documents.length - having + 0.5) / (having + 0.5))];
    }),
  );
  return documents
    .map((document) => ({
      item: document.item,
      score: words.reduce(
        (sum, word) =>
          sum +
          idf.get(word)! *
            (Object.keys(WEIGHTS) as Field[]).reduce((fieldSum, field) => {
              const count = document.counts[field].get(word) ?? 0;
              if (count === 0) return fieldSum;
              const norm = 1 - B + (B * document.lengths[field]) / Math.max(averages[field], 1);
              return fieldSum + WEIGHTS[field] * ((count * (K1 + 1)) / (count + K1 * norm));
            }, 0),
        0,
      ),
    }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

/** How a namespace is named in a script: `-` and `_` alike, and case alone does not tell two apart. */
export const namespaceKey = (name: string): string => name.toLowerCase().replace(/-/g, "_");
