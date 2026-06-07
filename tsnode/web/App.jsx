import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  answerDeleteRequest,
  downloadDiscoveredFile,
  fetchDiscoveredFiles,
  fetchHealth,
  fetchUploads,
  requestDeleteFile
} from "./api.js";
import styles from "./App.module.css";

const flagPositions = Array.from({ length: 22 }, (_, index) => ({
  left: `${(index * 37 + 8) % 96}%`,
  top: `${(index * 23 + 12) % 92}%`,
  scale: 0.7 + ((index * 17) % 5) * 0.12,
  rotate: `${((index * 29) % 28) - 14}deg`
}));

export default function App() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("connecting");
  const [startupLoading, setStartupLoading] = useState(true);
  const [transferActive, setTransferActive] = useState(false);
  const [contextMenu, setContextMenu] = useState();
  const [deleteRequests, setDeleteRequests] = useState([]);
  const [notice, setNotice] = useState();
  const queryClient = useQueryClient();
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const uploads = useQuery({ queryKey: ["uploads"], queryFn: fetchUploads });
  const discoveredFiles = useQuery({
    queryKey: ["discovered-files", page],
    queryFn: () => fetchDiscoveredFiles(page),
    keepPreviousData: true
  });
  const records = discoveredFiles.data?.records ?? [];
  const uploadRecords = uploads.data?.records ?? [];
  const pageCount = discoveredFiles.data?.pageCount ?? 1;
  const total = discoveredFiles.data?.total ?? 0;
  const connectedPeers = useMemo(() => uniquePeers(records), [records]);
  const connectedPeerTitle = connectedPeers.length > 0 ? formatConnectedPeers(connectedPeers) : "Connected peers";
  const subtitle = useMemo(() => {
    if (health.data?.peer?.name) {
      return `${health.data.peer.name} - ${total} files`;
    }

    return total ? `${total} files` : "DTF server";
  }, [health.data, total]);
  const download = useMutation({
    mutationFn: downloadDiscoveredFile,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["uploads"] });
    }
  });
  const deleteMutation = useMutation({
    async mutationFn(file) {
      const peers = file.peers ?? [];
      const results = await Promise.allSettled(peers.map((peer) => requestDeleteFile(file, peer)));
      const failed = results.filter((result) => result.status === "rejected").length;

      return { requested: peers.length - failed, failed };
    },
    onSuccess(result) {
      setNotice({
        title: "Delete request sent",
        body:
          result.failed > 0
            ? `${result.requested} peer${result.requested === 1 ? "" : "s"} contacted, ${result.failed} failed.`
            : `${result.requested} peer${result.requested === 1 ? "" : "s"} asked for approval.`
      });
    },
    onError(error) {
      setNotice({
        title: "Delete request failed",
        body: error instanceof Error ? error.message : "Could not send delete request."
      });
    }
  });
  const activeDownloadId = download.variables?.fileId;

  useEffect(() => {
    const timeout = window.setTimeout(() => setStartupLoading(false), 3000);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socket.addEventListener("open", () => setStatus("online"));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "server-status") {
          setStatus(message.status);
          setTransferActive(Boolean(message.transfer?.active));
        } else if (message.type === "transfer-status") {
          setTransferActive(Boolean(message.active));
        } else if (message.type === "server-started") {
          refreshOnceForStartup(message.startupId);
        } else if (message.type === "delete-request") {
          setDeleteRequests((current) => [...current, message.request]);
        } else if (message.type === "delete-request-resolved") {
          setDeleteRequests((current) => current.filter((request) => request.id !== message.requestId));
          void queryClient.invalidateQueries({ queryKey: ["uploads"] });
        } else if (message.type === "delete-request-decision") {
          setNotice({
            title: "Delete request answered",
            body: message.result?.message ?? "The peer answered your delete request."
          });
          void queryClient.invalidateQueries({ queryKey: ["discovered-files"] });
        }
      } catch {
        setStatus("online");
      }
    });
    socket.addEventListener("close", () => setStatus("offline"));
    socket.addEventListener("error", () => setStatus("offline"));
    return () => socket.close();
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return undefined;
    }

    const close = () => setContextMenu(undefined);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [contextMenu]);

  return (
    <main className={styles.shell}>
      <div className={styles.flags} aria-hidden="true">
        {flagPositions.map((flag, index) => (
          <span
            className={styles.flag}
            key={index}
            style={{
              left: flag.left,
              top: flag.top,
              transform: `rotate(${flag.rotate}) scale(${flag.scale})`
            }}
          />
        ))}
      </div>
      {startupLoading || transferActive ? <div className={styles.transferSpinner} aria-hidden="true" /> : null}

      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>Local DTF</p>
          <h1>File Harbor</h1>
          <p className={styles.subtitle}>{subtitle}</p>
        </div>
        <div className={styles.status} data-state={status}>
          <span />
          {status}
        </div>
      </header>

      <div className={styles.content}>
        <aside className={styles.localPanel}>
          <div className={styles.panelHeader}>
            <p className={styles.kicker}>Uploads</p>
            <h2>Local files</h2>
          </div>
          {uploads.isError ? (
            <p className={styles.panelNote}>Could not read uploads: {uploads.error.message}</p>
          ) : uploadRecords.length === 0 ? (
            <p className={styles.panelNote}>No files in tsnode/files/uploads.</p>
          ) : (
            <ul className={styles.fileList}>
              {uploadRecords.map((file) => (
                <li key={file.name} title={file.name}>
                  {file.name}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className={styles.remotePanel}>
          <div className={styles.panelHeader}>
            <p className={styles.kicker}>Peers</p>
            <h2>{connectedPeerTitle}</h2>
          </div>
          {discoveredFiles.isError ? (
            <section className={styles.empty}>Discovery unavailable: {discoveredFiles.error.message}</section>
          ) : records.length === 0 ? (
            <section className={styles.empty}>No files found on other devices yet.</section>
          ) : (
            <section className={styles.grid} aria-busy={discoveredFiles.isLoading}>
              {records.map((file) => (
                <article
                  className={styles.card}
                  key={file.fileId}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setContextMenu({ file, x: event.clientX, y: event.clientY });
                  }}
                >
                  <div className={styles.cardTop}>
                    <span className={styles.media}>{file.mediaType || "application/octet-stream"}</span>
                    <span>{formatBytes(file.fileSize)}</span>
                  </div>
                  <div className={styles.fileTitle}>
                    <h2>{file.name}</h2>
                    <button
                      type="button"
                      onClick={() => download.mutate(file)}
                      disabled={download.isPending && activeDownloadId === file.fileId}
                    >
                      {download.isPending && activeDownloadId === file.fileId ? "Saving..." : "Download"}
                    </button>
                  </div>
                  {download.isSuccess && activeDownloadId === file.fileId ? (
                    <p className={styles.downloadStatus}>Saved to local uploads.</p>
                  ) : null}
                  {download.isError && activeDownloadId === file.fileId ? (
                    <p className={styles.downloadStatus}>Download failed: {download.error.message}</p>
                  ) : null}
                  <p className={styles.fileId}>{file.fileId}</p>
                  <div className={styles.tags}>
                    {file.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  {file.peers.length > 0 ? (
                    <div className={styles.peerBlock}>
                      <p>Available from</p>
                      <div className={styles.peers}>
                        {file.peers.map((peer) => (
                          <span key={peer.peerId}>{peerDisplayName(peer)}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>
          )}

          <nav className={styles.pagination} aria-label="File pages">
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              Previous
            </button>
            <span>
              Page {page} of {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
              disabled={page >= pageCount}
            >
              Next
            </button>
          </nav>
        </section>
      </div>
      {contextMenu ? (
        <div className={styles.contextMenu} style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            type="button"
            onClick={() => {
              download.mutate(contextMenu.file);
              setContextMenu(undefined);
            }}
          >
            Download
          </button>
          <button
            type="button"
            onClick={() => {
              deleteMutation.mutate(contextMenu.file);
              setContextMenu(undefined);
            }}
          >
            Request delete from peers
          </button>
        </div>
      ) : null}
      {deleteRequests[0] ? (
        <DecisionDialog
          request={deleteRequests[0]}
          onAnswer={async (decision) => {
            await answerDeleteRequest(deleteRequests[0].id, decision);
          }}
        />
      ) : null}
      {notice ? <NoticeDialog notice={notice} onClose={() => setNotice(undefined)} /> : null}
    </main>
  );
}

function DecisionDialog({ request, onAnswer }) {
  const [pending, setPending] = useState(false);

  async function answer(decision) {
    setPending(true);

    try {
      await onAnswer(decision);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.dialogBackdrop}>
      <section className={styles.dialog}>
        <p className={styles.kicker}>Delete request</p>
        <h2>{request.requester?.name || "A peer"} wants to delete this file</h2>
        <p>{request.file?.name}</p>
        <p className={styles.dialogMeta}>{request.file?.fileId}</p>
        <div className={styles.dialogActions}>
          <button type="button" disabled={pending} onClick={() => void answer("deny")}>
            Deny
          </button>
          <button type="button" disabled={pending} onClick={() => void answer("accept")}>
            Accept
          </button>
        </div>
      </section>
    </div>
  );
}

function NoticeDialog({ notice, onClose }) {
  return (
    <div className={styles.dialogBackdrop}>
      <section className={styles.dialog}>
        <p className={styles.kicker}>Peer response</p>
        <h2>{notice.title}</h2>
        <p>{notice.body}</p>
        <div className={styles.dialogActions}>
          <button type="button" onClick={onClose}>
            OK
          </button>
        </div>
      </section>
    </div>
  );
}

function refreshOnceForStartup(startupId) {
  if (!startupId || typeof window === "undefined") {
    return;
  }

  const key = "dtf-refreshed-startup-id";

  if (window.sessionStorage.getItem(key) === startupId) {
    return;
  }

  window.sessionStorage.setItem(key, startupId);
  window.setTimeout(() => window.location.reload(), 100);
}

function uniquePeers(records) {
  const peers = new Map();

  for (const record of records) {
    for (const peer of record.peers ?? []) {
      if (!peers.has(peer.peerId)) {
        peers.set(peer.peerId, peer);
      }
    }
  }

  return [...peers.values()].sort((left, right) => peerDisplayName(left).localeCompare(peerDisplayName(right)));
}

function formatConnectedPeers(peers) {
  if (peers.length <= 2) {
    return `Connected peers: ${peers.map(peerDisplayName).join(", ")}`;
  }

  return `Connected peers: ${peers.length}`;
}

function peerDisplayName(peer) {
  const name = peer.name?.trim();

  if (name) {
    return name;
  }

  const address = peerAddress(peer);

  if (address) {
    return address;
  }

  return `Peer ${String(peer.peerId).slice(0, 8)}`;
}

function peerAddress(peer) {
  if (typeof peer.address === "string" && peer.address.trim()) {
    return peer.address;
  }

  if (peer.address?.address) {
    return peer.address.port ? `${peer.address.address}:${peer.address.port}` : peer.address.address;
  }

  return "";
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
