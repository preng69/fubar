const PAGE_SIZE = 20;

export async function fetchFiles(page) {
  const response = await fetch(`/api/files?page=${page}&pageSize=${PAGE_SIZE}`);
  return readJson(response);
}

export async function fetchHealth() {
  const response = await fetch("/api/health");
  return readJson(response);
}

async function readJson(response) {
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }

  return body;
}
