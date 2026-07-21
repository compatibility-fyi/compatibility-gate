import type { RepositoryReader } from "../src/types.js";

export class MemoryRepository implements RepositoryReader {
  constructor(private readonly trees: Record<string, Record<string, string>>) {}

  listFiles(ref: string): Promise<string[]> {
    return Promise.resolve(Object.keys(this.tree(ref)));
  }

  readFile(ref: string, path: string): Promise<string> {
    const value = this.tree(ref)[path];
    if (value === undefined) {
      return Promise.reject(new Error(`Missing ${path} at ${ref}`));
    }
    return Promise.resolve(value);
  }

  private tree(ref: string): Record<string, string> {
    const tree =
      this.trees[ref] ??
      (/^[a-f0-9]{40}$/.test(ref) ? this.trees.head : undefined);
    if (!tree) {
      throw new Error(`Missing tree ${ref}`);
    }
    return tree;
  }
}

export const operator127 = `apiVersion: source.toolkit.fluxcd.io/v1
kind: GitRepository
metadata:
  name: cloudnative-pg
spec:
  ref:
    tag: v1.27.0
`;

export const operator130 = operator127.replace("v1.27.0", "v1.30.0");

export function cluster(version: string): string {
  return `apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: database
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:${version}
`;
}

export const configurationYaml = `version: 1
gates:
  - id: cnpg-postgresql
    project:
      id: cloudnativepg
      version:
        files:
          - operator.yaml
        document:
          kind: GitRepository
          metadata.name: cloudnative-pg
        value: spec.ref.tag
    dependency:
      id: postgresql
      versions:
        files:
          - clusters/*.yaml
        document:
          apiVersion: postgresql.cnpg.io/v1
          kind: Cluster
        value: spec.imageName
        extract: ':(?<version>[^@]+)$'
`;
