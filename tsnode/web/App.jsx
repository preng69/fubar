import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchFiles, fetchHealth } from "./api.js";
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
  const health = useQuery({ queryKey: ["health"], queryFn: fetchHealth });
  const files = useQuery({
    queryKey: ["files", page],
    queryFn: () => fetchFiles(page),
    keepPreviousData: true
  });
  const records = files.data?.records ?? [];
  const pageCount = files.data?.pageCount ?? 1;
  const total = files.data?.total ?? 0;
  const subtitle = useMemo(() => {
    if (health.data?.peer?.name) {
      return `${health.data.peer.name} · ${total} files`;
    }

    return total ? `${total} files` : "DTF bridge";
  }, [health.data, total]);

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

      {files.isError ? (
        <section className={styles.empty}>Bridge unavailable: {files.error.message}</section>
      ) : (
        <section className={styles.grid} aria-busy={files.isLoading}>
          {records.map((file) => (
            <article className={styles.card} key={file.fileId}>
              <div className={styles.cardTop}>
                <span className={styles.media}>{file.mediaType || "application/octet-stream"}</span>
                <span>{formatBytes(file.fileSize)}</span>
              </div>
              <h2>{file.name}</h2>
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
