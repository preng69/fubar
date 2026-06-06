import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { downloadDiscoveredFile, fetchDiscoveredFiles, fetchHealth, fetchUploads } from "./api.js";
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
  const subtitle = useMemo(() => {
    if (health.data?.peer?.name) {
      return `${health.data.peer.name} - ${total} files`;
    }

    return total ? `${total} files` : "DTF bridge";
  }, [health.data, total]);
  const download = useMutation({
    mutationFn: downloadDiscoveredFile,
    onSuccess() {
      void queryClient.invalidateQueries({ queryKey: ["uploads"] });
    }
  });

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
    socket.addEventListener("open", () => setStatus("online"));
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "server-status") {
          setStatus(message.status);
        }
      } catch {
        setStatus("online");
      }
    });
    socket.addEventListener("close", () => setStatus("offline"));
    socket.addEventListener("error", () => setStatus("offline"));
    return () => socket.close();
  }, []);

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
            <h2>Other devices</h2>
          </div>
          {discoveredFiles.isError ? (
            <section className={styles.empty}>Discovery unavailable: {discoveredFiles.error.message}</section>
          ) : records.length === 0 ? (
            <section className={styles.empty}>No files found on other devices yet.</section>
          ) : (
            <section className={styles.grid} aria-busy={discoveredFiles.isLoading}>
              {records.map((file) => (
                <article className={styles.card} key={file.fileId}>
                  <div className={styles.cardTop}>
                    <span className={styles.media}>{file.mediaType || "application/octet-stream"}</span>
                    <span>{formatBytes(file.fileSize)}</span>
                  </div>
                  <div className={styles.fileTitle}>
                    <h2>{file.name}</h2>
                    <button
                      type="button"
                      onClick={() => download.mutate(file)}
                      disabled={download.isPending}
                    >
                      Download
                    </button>
                  </div>
                  <p className={styles.fileId}>{file.fileId}</p>
                  <div className={styles.tags}>
                    {file.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className={styles.peers}>
                    {file.peers.map((peer) => (
                      <span key={peer.peerId}>{peer.name}</span>
                    ))}
                  </div>
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
    </main>
  );
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
