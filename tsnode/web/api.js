const PAGE_SIZE = 20;

export async function fetchFiles(page) {
  const response = await fetch(`/api/files?page=${page}&pageSize=${PAGE_SIZE}`);
  return readJson(response);
}

export async function fetchDiscoveredFiles(page) {
  const response = await fetch(`/api/discover?page=${page}&pageSize=${PAGE_SIZE}`);
  return readJson(response);
}

export async function fetchHealth() {
  const response = await fetch("/api/health");
  return readJson(response);
}

export async function fetchUploads() {
  const response = await fetch("/api/uploads");
  return readJson(response);
}

export async function downloadDiscoveredFile(file) {
  const response = await fetch("/api/download", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ file })
  });
  return readJson(response);
}

export async function requestDeleteFile(file, peer) {
  const response = await fetch("/api/delete-request", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ file, peer })
  });
  return readJson(response);
}

export async function answerDeleteRequest(requestId, decision) {
  const response = await fetch(`/api/delete-requests/${requestId}/${decision}`, {
    method: "POST"
  });
  return readJson(response);
}

async function readJson(response) {
  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }

  return body;
}
