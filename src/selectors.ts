import { minimatch } from "minimatch";
import { parseAllDocuments } from "yaml";

import type { RepositoryReader, ValueSelector } from "./types";

const maxMatchingFiles = 256;
const maxSelectedValues = 100;

export async function resolveSelector(
  reader: RepositoryReader,
  ref: string,
  selector: ValueSelector,
): Promise<string[]> {
  const repositoryFiles = await reader.listFiles(ref);
  const matchingFiles = repositoryFiles.filter((file) =>
    selector.files.some((pattern) =>
      minimatch(file, pattern, { dot: true, nonegate: true }),
    ),
  );

  if (matchingFiles.length > maxMatchingFiles) {
    throw new Error(
      `Selector matched ${matchingFiles.length} files, exceeding the limit of ${maxMatchingFiles}`,
    );
  }

  const values: string[] = [];
  for (const file of matchingFiles.sort()) {
    const raw = await reader.readFile(ref, file);
    const documents = parseAllDocuments(raw, { prettyErrors: true });

    for (const [index, document] of documents.entries()) {
      if (document.errors.length > 0) {
        throw new Error(
          `Invalid YAML in ${file} document ${index + 1}: ${document.errors.map((error) => error.message).join("; ")}`,
        );
      }

      const value = document.toJS() as unknown;
      if (!matchesDocument(value, selector.document)) {
        continue;
      }

      const selected = getPath(value, selector.value);
      if (selected === undefined || selected === null) {
        continue;
      }
      if (typeof selected !== "string" && typeof selected !== "number") {
        throw new Error(
          `${file} ${selector.value} must resolve to a string or number`,
        );
      }

      const normalized = extractValue(
        String(selected),
        selector.extract,
        file,
        selector.value,
      );
      if (!values.includes(normalized)) {
        values.push(normalized);
      }
      if (values.length > maxSelectedValues) {
        throw new Error(
          `Selector returned more than ${maxSelectedValues} unique values`,
        );
      }
    }
  }

  return values;
}

function matchesDocument(
  value: unknown,
  selector: Record<string, string | number | boolean> | undefined,
): boolean {
  if (!selector) {
    return true;
  }

  return Object.entries(selector).every(
    ([path, expected]) => getPath(value, path) === expected,
  );
}

export function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function extractValue(
  raw: string,
  pattern: string | undefined,
  file: string,
  path: string,
): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${file} ${path} resolved to an empty value`);
  }
  if (!pattern) {
    return value;
  }

  const match = new RegExp(pattern).exec(value);
  if (!match) {
    throw new Error(
      `${file} ${path} value ${JSON.stringify(value)} did not match extract pattern`,
    );
  }
  const extracted = match.groups?.version ?? match[1];
  if (!extracted?.trim()) {
    throw new Error(
      `${file} ${path} extract pattern must provide a named version group or capture`,
    );
  }
  return extracted.trim();
}
