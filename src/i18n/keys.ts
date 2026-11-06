/**
 * Typed translation keys, derived at type level from es.json (the source of
 * truth). Adding a key to es.json makes it available here automatically.
 * Plural keys (`foo_one` / `foo_other`) are exposed as their base key `foo`.
 */
import type es from "./es.json";

type Leaves<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Leaves<T[K]>}`;
}[keyof T & string];

type StripPlural<K extends string> = K extends `${infer B}_one`
  ? B
  : K extends `${infer B}_other`
    ? B
    : K;

type AllLeaves = Leaves<typeof es>;

export type TKey = StripPlural<AllLeaves> | AllLeaves;
