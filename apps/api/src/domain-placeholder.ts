export interface PlaceholderItem {
  id: string;
  label: string;
  status: string;
}

export function placeholderItems(domain: string): PlaceholderItem[] {
  return [
    {
      id: `${domain}-stage-1`,
      label: `${domain} storage is ready for Stage 1 data wiring`,
      status: "empty"
    }
  ];
}
