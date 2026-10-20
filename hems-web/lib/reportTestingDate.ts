export function commonTestingDate(values: Array<string | null | undefined>): string {
  if (!values.length) return "";
  const dates = values.map(value => value?.slice(0, 10) || "");
  return dates.every(date => date === dates[0]) ? dates[0] : "";
}

export function testingDateSummary(values: Array<string | null | undefined>): string {
  const common = commonTestingDate(values);
  if (common) return common;
  return values.some(Boolean) ? "Different saved dates" : "Not set";
}
