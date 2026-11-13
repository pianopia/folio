import { useEffect, useRef, useState, useMemo, type FormEvent } from "react";
import {
  Search,
  Plus,
  ArrowUpRight,
  LayoutGrid,
  Heart,
  Folder,
  Clock3,
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  X,
  Check,
  SlidersHorizontal,
  List,
  Settings,
  Image as ImageIcon,
  ArrowLeft,
  Trash2,
  RefreshCw,
  ExternalLink,
  Menu,
  Cloud,
  Layers,
  Download,
  Copy,
  LoaderCircle,
} from "lucide-react";
import ArtworkViewer from "./ArtworkViewer";
import UploadPanel from "./UploadPanel";
import GroupSharing from "./GroupSharing";
import type { Artwork } from "@folio/shared";
import {
  request,
  sampleData,
  apiBase,
  getAuthToken,
  setAuthToken,
  type LibraryData,
} from "./api";

import { copyArtworkImage } from "./clipboard";

import ArtImage, { DriveThumbnail } from "./ArtImage";
import {
  loadDrivePage,
  loadDrivePreview,
  previewPath,
  clearDriveCaches,
  type DriveFile,
} from "./drive-client";

function DriveIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 2h8l8 14h-8z" fill="#fbbc04" />
      <path d="M8 2 0 16l4 7 8-14z" fill="#34a853" />
      <path d="M4 23h16l4-7H8z" fill="#4285f4" />
    </svg>
  );
}
function Dialog({
  title,
  children,
  onClose,
  wide = false,
  onKeyDown,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLDialogElement>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      aria-label={title}
      ref={ref}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={onClose}
      onKeyDown={onKeyDown}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon" aria-label="閉じる" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export default function Library() {
  const [user, setUser] = useState<{
    id: string;
    email: string;
    name: string;
  } | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [demoAllowed, setDemoAllowed] = useState(false);
  const [deviceCode, setDeviceCode] = useState("");
  const [deviceApproved, setDeviceApproved] = useState(false);
  const [nativeDevice, setNativeDevice] = useState(false);
  const [data, setData] = useState<LibraryData>({ groups: [], artworks: [] });
  const [mode, setMode] = useState<"loading" | "live" | "demo">("loading");
  const [view, setView] = useState("all"),
    [groupId, setGroupId] = useState("all"),
    [collection, setCollection] = useState("all"),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("new"),
    [layout, setLayout] = useState("grid");
  const [modal, setModal] = useState<
      "group" | "add" | "drive" | "settings" | null
    >(null),
    [selected, setSelected] = useState<Artwork | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [toast, setToast] = useState(""),
    [navOpen, setNavOpen] = useState(false);
  const [connected, setConnected] = useState(false),
    [configured, setConfigured] = useState(false),
    [files, setFiles] = useState<DriveFile[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [folder, setFolder] = useState(""),
    [pageToken, setPageToken] = useState<string | undefined>(),
    [importGroup, setImportGroup] = useState("studio");
  const [copyingId, setCopyingId] = useState<string | null>(null);
  async function copyImage(art: Artwork) {
    if (copyingId) return;
    setCopyingId(art.id);
    try {
      await copyArtworkImage(art);
      notify(
        "画像をコピーしました。チャットやデザインツールに貼り付けられます。",
      );
    } catch (error) {
      notify(
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "コピーが許可されませんでした。ブラウザのクリップボード権限を確認して、もう一度押してください。"
          : error instanceof TypeError
            ? "画像を取得できませんでした。画像配信元が外部からのコピーを許可しているか確認してください。"
            : error instanceof Error
              ? error.message
              : "画像をコピーできませんでした。",
      );
    } finally {
      setCopyingId(null);
    }
  }
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  function notify(t: string) {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  }
  async function load() {
    try {
      const identity = await request<{
        user: typeof user;
        configured: boolean;
        deletionPending?: boolean;
      }>("/auth/me");
      setUser(identity.user);
      setConfigured(identity.configured);
      clearDriveCaches();
      setFiles([]);
      setChosen([]);
      setSelected(null);
      if (!identity.user) {
        setData({ groups: [], artworks: [] });
        setConnected(false);
        setMode("demo");
        return;
      }
      if (identity.deletionPending) {
        setData({ groups: [], artworks: [] });
        setConnected(false);
        setMode("live");
        setError(
          "アカウントの削除処理中です。スマホアプリの設定から削除を再試行してください。",
        );
        return;
      }
      const d = await request<LibraryData>("/library");
      const status = await request<{ connected: boolean }>("/drive/status");
      setData(d);
      setMode("live");
      setConnected(status.connected);
    } catch (e) {
      setData({ groups: [], artworks: [] });
      setConnected(false);
      clearDriveCaches();
      setError((e as Error).message);
    } finally {
      setAuthReady(true);
    }
  }
  useEffect(() => {
    setAuthToken("");
    const code =
      new URLSearchParams(window.location.search).get("device") ?? "";
    if (/^[A-F0-9]{12}$/.test(code)) setDeviceCode(code);
    setNativeDevice(
      new URLSearchParams(window.location.search).get("native") === "1",
    );
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(toastTimer.current);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  function update(d: LibraryData) {
    setData(d);
    if (mode === "demo") localStorage.setItem("folio-demo", JSON.stringify(d));
  }
  function open(m: typeof modal) {
    setError("");
    setModal(m);
    setNavOpen(false);
  }
  function navigate(v: string, g = "all") {
    setSort("new");
    setView(v);
    setGroupId(g);
    setCollection("all");
    setQuery("");
    setNavOpen(false);
  }
  async function change(a: Artwork, patch: Partial<Artwork>) {
    if (
      mode === "live" &&
      data.groups.find((g) => g.id === a.groupId)?.ownerId !== user?.id
    ) {
      notify("このグループは閲覧のみです");
      return false;
    }
    try {
      const updated =
        mode === "demo"
          ? { ...a, ...patch }
          : await request<Artwork>(`/artworks/${a.id}`, {
              method: "PATCH",
              body: JSON.stringify(patch),
            });
      update({
        ...data,
        artworks: data.artworks.map((x) => (x.id === a.id ? updated : x)),
      });
      if (selected?.id === a.id) setSelected(updated);
      return true;
    } catch (e) {
      notify((e as Error).message);
      return false;
    }
  }
  async function submit(
    e: FormEvent<HTMLFormElement>,
    kind: "group" | "add" | "edit",
  ) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const b = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (kind === "group") {
        const g =
          mode === "demo"
            ? {
                id: crypto.randomUUID(),
                name: String(b.name).trim(),
                color: "#a6b7a4",
              }
            : await request<LibraryData["groups"][number]>("/groups", {
                method: "POST",
                body: JSON.stringify(b),
              });
        update({ ...data, groups: [...data.groups, g] });
        navigate("all", g.id);
        notify("グループを作成しました");
      } else if (kind === "edit" && selected) {
        const ok = await change(selected, {
          title: String(b.title),
          groupId: String(b.groupId),
          collection: String(b.collection),
          tags: String(b.tags)
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        });
        if (!ok) return;
        notify("作品情報を保存しました");
        setSelected(null);
      } else {
        const a =
          mode === "demo"
            ? {
                title: String(b.title),
                groupId: String(b.groupId),
                collection: String(b.collection),
                url: String(b.url),
                id: crypto.randomUUID(),
                tags: [],
                favorite: false,
                source: "sample" as const,
                createdAt: new Date().toISOString(),
              }
            : await request<Artwork>("/artworks", {
                method: "POST",
                body: JSON.stringify(b),
              });
        update({ ...data, artworks: [a, ...data.artworks] });
        notify("作品を追加しました");
      }
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const driveRequestId = useRef(0);
  async function driveFiles(folderId = "", more?: string, refresh = false) {
    const requestId = ++driveRequestId.current;
    setBusy(true);
    setError("");
    try {
      const result = await loadDrivePage(folderId, more, refresh);
      if (requestId !== driveRequestId.current) return;
      setFiles((prev) => (more ? [...prev, ...result.files] : result.files));
      setFolder(folderId);
      setPageToken(result.nextPageToken);
    } catch (e) {
      if (requestId === driveRequestId.current) setError((e as Error).message);
    } finally {
      if (requestId === driveRequestId.current) setBusy(false);
    }
  }
  async function openDrive() {
    open("drive");
    setImportGroup(
      groupId === "all"
        ? (data.groups.find((g) => g.ownerId === user?.id)?.id ?? "")
        : groupId,
    );
    setChosen([]);
    if (connected) await driveFiles();
  }
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await request<{ url: string }>("/drive/connect");
      window.location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importFiles() {
    setBusy(true);
    try {
      const r = await request<{ artworks: Artwork[] }>("/drive/import", {
        method: "POST",
        body: JSON.stringify({ ids: chosen, groupId: importGroup }),
      });
      const ids = new Set(r.artworks.map((x) => x.id));
      update({
        ...data,
        artworks: [
          ...r.artworks,
          ...data.artworks.filter((x) => !ids.has(x.id)),
        ],
      });
      setModal(null);
      notify(`${r.artworks.length}点の作品を取り込みました`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const collections = Array.from(
    new Set(
      data.artworks
        .filter((a) => groupId === "all" || a.groupId === groupId)
        .map((a) => a.collection),
    ),
  );
  const visible = useMemo(
    () =>
      data.artworks
        .filter(
          (a) =>
            (groupId === "all" || a.groupId === groupId) &&
            (view !== "favorites" || a.favorite) &&
            (collection === "all" || a.collection === collection) &&
            `${a.title} ${a.tags.join(" ")} ${a.collection}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "name"
            ? a.title.localeCompare(b.title)
            : sort === "old"
              ? a.createdAt.localeCompare(b.createdAt)
              : b.createdAt.localeCompare(a.createdAt),
        ),
    [data.artworks, groupId, view, collection, query, sort],
  );
  const activeGroup = data.groups.find((g) => g.id === groupId);
  const selectedIndex = selected
    ? visible.findIndex((art) => art.id === selected.id)
    : -1;
  function navigateArtwork(direction: number) {
    if (selectedIndex < 0 || visible.length < 2) return;
    setSelected(
      visible[(selectedIndex + direction + visible.length) % visible.length],
    );
    setError("");
  }
  useEffect(() => {
    if (selectedIndex < 0) return;
    for (const offset of [1, -1, 2]) {
      const next =
        visible[(selectedIndex + offset + visible.length) % visible.length];
      if (next && next.source !== "sample")
        void loadDrivePreview(previewPath(next, 1024)).catch(() => {});
    }
  }, [selectedIndex, visible]);
  const ownedGroups =
    mode === "demo"
      ? data.groups
      : data.groups.filter((g) => g.ownerId === user?.id);
  const canEditSelected =
    mode === "demo" ||
    data.groups.find((g) => g.id === selected?.groupId)?.ownerId === user?.id;
  const chosenSet = new Set(chosen);
  const title =
    view === "favorites"
      ? "Favorites"
      : view === "collections"
        ? "Collections"
        : view === "recent"
          ? "Recently added"
          : (activeGroup?.name ?? "All artworks");
  const loginHref = `${apiBase()}/api/auth/login${deviceCode ? `?device=${deviceCode}${nativeDevice ? "&native=1" : ""}` : ""}`;
  if (!authReady || (!user && !demoAllowed))
    return (
      <main className="auth-page">
        <div className="auth-card">
          <a className="auth-logo" href="/">
            folio ✳
          </a>
          <h1>あなたの作品に、ひとつの居場所を。</h1>
          <p>
            Googleでログインして、自分だけのライブラリを始めましょう。Driveは本人だけが閲覧でき、選んだ作品をグループに共有できます。
          </p>
          {!authReady ? (
            <p>接続を確認しています…</p>
          ) : (
            <a className="button primary full" href={loginHref}>
              Googleでログイン
            </a>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {authReady && !deviceCode && (
            <button
              className="text-button"
              onClick={() => {
                setDemoAllowed(true);
                setMode("demo");
                setData(sampleData());
              }}
            >
              サンプルを見る
            </button>
          )}
        </div>
      </main>
    );
  return (
    <div className="app-shell">
      {user && deviceCode && (
        <section className="device-approval" aria-label="スマホ接続">
          <h2>スマホを接続</h2>
          <p>
            {user.email}{" "}
            としてスマホアプリにログインします。スマホに表示されたコードと一致する場合だけ許可してください。
          </p>
          <strong>{deviceCode}</strong>
          <button
            className="button primary"
            disabled={deviceApproved}
            onClick={async () => {
              try {
                await request("/auth/device/approve", {
                  method: "POST",
                  body: JSON.stringify({ userCode: deviceCode }),
                });
                setDeviceApproved(true);
                if (nativeDevice) window.location.assign("folio://auth");
              } catch (e) {
                notify((e as Error).message);
              }
            }}
          >
            {deviceApproved
              ? "許可済み：スマホへ戻ってください"
              : "このスマホへの接続を許可"}
          </button>
        </section>
      )}

      <aside className={navOpen ? "sidebar open" : "sidebar"}>
        <a href="/" className="brand">
          folio<span>✳</span>
        </a>
        <button className="workspace" onClick={() => navigate("all")}>
          <span className="workspace-icon">S</span>
          <span>
            Studio workspace<small>Your creative home</small>
          </span>
          <ChevronDown size={14} />
        </button>
        <div className="nav-label">LIBRARY</div>
        <nav>
          <button
            className={
              view === "all" && groupId === "all"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() => navigate("all")}
          >
            <LayoutGrid size={18} />
            All artworks<span className="count">{data.artworks.length}</span>
          </button>
          <button
            className={view === "favorites" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("favorites")}
          >
            <Heart size={18} />
            Favorites
            <span className="count">
              {data.artworks.filter((a) => a.favorite).length}
            </span>
          </button>
          <button
            className={view === "collections" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("collections")}
          >
            <Layers size={18} />
            Collections
            <span className="count">
              {new Set(data.artworks.map((a) => a.collection)).size}
            </span>
          </button>
          <button
            className={view === "recent" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("recent")}
          >
            <Clock3 size={18} />
            Recently added
          </button>
        </nav>
        <div className="nav-label label-with-action">
          YOUR GROUPS
          <button
            className="icon"
            aria-label="グループを作成"
            onClick={() => open("group")}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav>
          {data.groups.map((g) => (
            <button
              key={g.id}
              className={groupId === g.id ? "nav-item active" : "nav-item"}
              onClick={() => navigate("all", g.id)}
            >
              <span className="group-dot" style={{ background: g.color }} />
              {g.name}
              <span className="count">
                {data.artworks.filter((a) => a.groupId === g.id).length}
              </span>
            </button>
          ))}
        </nav>
        <button className="new-group" onClick={() => open("group")}>
          <Plus size={16} /> Create a group
        </button>
        <div className="sidebar-bottom">
          <div className="drive-card">
            <div className="drive-card-top">
              <DriveIcon />
              <strong>More room for ideas.</strong>
            </div>
            <p>
              Google Driveの作品を、
              <br />
              ひとつのクリエイティブな場所に。
            </p>
            <button onClick={openDrive}>
              {connected ? "Driveを開く" : "Google Driveを接続"}
              <ArrowUpRight size={15} />
            </button>
          </div>
          <button className="profile" onClick={() => open("settings")}>
            <span className="avatar">S</span>
            <span>
              Studio workspace
              <small>{mode === "demo" ? "Demo workspace" : user?.email}</small>
            </span>
            <Settings size={17} />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon mobile-menu"
              aria-label="メニュー"
              onClick={() => setNavOpen(!navOpen)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="top-actions">
            <span className={mode === "live" ? "status live" : "status"}>
              <i />
              {mode === "loading"
                ? "Loading…"
                : mode === "demo"
                  ? "Demo mode"
                  : "API connected"}
            </span>
            <button
              className="icon"
              aria-label="設定"
              onClick={() => open("settings")}
            >
              <Settings size={18} />
            </button>
            <span className="avatar small">S</span>
          </div>
        </header>
        <div
          className={
            connected ? "main-content drive-connected" : "main-content"
          }
        >
          {!connected && groupId === "all" && view === "all" && (
            <section className="welcome">
              <div className="welcome-copy">
                <span className="eyebrow">
                  <span /> A LITTLE SPACE FOR BIG IDEAS
                </span>
                <h1>
                  Your creative world,
                  <br />
                  all in one place<span>.</span>
                </h1>
                <p>
                  ひらめきも、つくったものも。チームのアイデアが集まる場所。
                </p>
                <button onClick={openDrive}>
                  Google Driveとつなげる
                  <ArrowUpRight size={16} />
                </button>
              </div>
              <div className="art-scene" aria-hidden="true">
                <div className="scene-grid" />
                <div className="scene-frame">
                  <div className="scene-orb" />
                  <span>
                    MAKE ROOM
                    <br />
                    FOR INSPIRATION.
                  </span>
                  <small>FOLIO / STUDIO SERIES — 001</small>
                </div>
                <div className="scene-card">
                  <span>✳</span>
                  <p>
                    A fresh
                    <br />
                    perspective.
                  </p>
                  <small>IDEAS START HERE ↗</small>
                </div>
                <span className="scene-spark">✳</span>
              </div>
            </section>
          )}
          <div className="section-heading">
            <div>
              <div className="section-overline">YOUR CREATIVE LIBRARY</div>
              <h2>
                {title}
                <span>{visible.length}</span>
              </h2>
            </div>
            <div className="heading-actions">
              <button
                aria-label="Google Driveから取り込む"
                className="button secondary"
                onClick={openDrive}
              >
                <DriveIcon />
                <span>Driveから取り込む</span>
              </button>
              <button className="button primary" onClick={() => open("add")}>
                <Plus size={17} />
                <span>作品を追加</span>
              </button>
            </div>
          </div>
          <div className="library-tools">
            <div className="filters">
              <button
                className={collection === "all" ? "filter active" : "filter"}
                onClick={() => setCollection("all")}
              >
                すべて
              </button>
              {collections.map((c) => (
                <button
                  className={collection === c ? "filter active" : "filter"}
                  key={c}
                  onClick={() => setCollection(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="tools-right">
              <label className="search">
                <Search size={16} />
                <input
                  aria-label="作品を検索"
                  placeholder="Search your inspiration…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    className="icon"
                    aria-label="検索をクリア"
                    onClick={() => setQuery("")}
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
              <label className="sort">
                <SlidersHorizontal size={15} />
                <select
                  aria-label="並び順"
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                >
                  <option value="new">新しい順</option>
                  <option value="old">古い順</option>
                  <option value="name">名前順</option>
                </select>
              </label>
              <div className="layout-switch">
                <button
                  className={layout === "grid" ? "icon active" : "icon"}
                  aria-label="グリッド表示"
                  onClick={() => setLayout("grid")}
                >
                  <LayoutGrid size={17} />
                </button>
                <button
                  className={layout === "list" ? "icon active" : "icon"}
                  aria-label="リスト表示"
                  onClick={() => setLayout("list")}
                >
                  <List size={18} />
                </button>
              </div>
            </div>
          </div>
          {mode === "demo" && (
            <div className="demo-note">
              <span>
                サンプル作品で操作できます。実際のライブラリはGoogleログイン後に利用できます。
              </span>
              <button onClick={() => open("settings")}>
                Googleでログイン <ArrowUpRight size={12} />
              </button>
            </div>
          )}
          {view === "collections" && collection === "all" ? (
            <div className="collections-grid">
              {collections.map((c) => {
                const arts = data.artworks.filter((a) => a.collection === c);
                return (
                  <button
                    key={c}
                    className="collection-card"
                    onClick={() => setCollection(c)}
                  >
                    <div className="collection-images">
                      {arts.slice(0, 3).map((a) => (
                        <ArtImage key={a.id} art={a} alt="" />
                      ))}
                    </div>
                    <div>
                      <Folder size={17} />
                      <strong>{c}</strong>
                      <span>{arts.length} artworks</span>
                      <ArrowUpRight size={17} />
                    </div>
                  </button>
                );
              })}
            </div>
          ) : visible.length ? (
            <div
              className={layout === "list" ? "artworks list-view" : "artworks"}
            >
              {visible.map((a, i) => (
                <article className="art-card" key={a.id}>
                  <button
                    className={`art-image image-${i % 6}`}
                    onClick={() => {
                      setError("");
                      setSelected(a);
                    }}
                    aria-label={`${a.title}を開く`}
                  >
                    <ArtImage art={a} alt={a.title} />
                    <span className="image-open">
                      <ArrowUpRight size={19} />
                    </span>
                    <span className="file-type">
                      {a.source !== "sample" ? (
                        <>
                          <Cloud size={12} /> DRIVE
                        </>
                      ) : (
                        "JPG"
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="copy-image"
                    aria-label={`${a.title}の画像をコピー`}
                    title="画像をコピー"
                    disabled={copyingId !== null}
                    onClick={() => copyImage(a)}
                  >
                    {copyingId === a.id ? (
                      <LoaderCircle size={15} className="copy-spinner" />
                    ) : (
                      <Copy size={15} />
                    )}
                  </button>
                  <button
                    className={a.favorite ? "favorite on" : "favorite"}
                    onClick={() => change(a, { favorite: !a.favorite })}
                    aria-label={
                      a.favorite ? "お気に入りを解除" : "お気に入りに追加"
                    }
                  >
                    <Heart
                      size={16}
                      fill={a.favorite ? "currentColor" : "none"}
                    />
                  </button>
                  <div className="art-info">
                    <button
                      onClick={() => {
                        setError("");
                        setSelected(a);
                      }}
                    >
                      <h3>{a.title}</h3>
                    </button>
                    <div className="art-meta">
                      <span
                        className="group-dot"
                        style={{
                          background: data.groups.find(
                            (g) => g.id === a.groupId,
                          )?.color,
                        }}
                      />
                      {data.groups.find((g) => g.id === a.groupId)?.name}
                      <span className="meta-separator">·</span>
                      <span>{a.collection}</span>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">
              <ImageIcon size={36} />
              <h3>{query ? "作品が見つかりません" : "まだ作品がありません"}</h3>
              <p>
                {query
                  ? "別のタイトルやタグで検索してみてください。"
                  : "Driveの作品やお気に入りの画像を追加しましょう。"}
              </p>
              <button
                className="button secondary"
                onClick={() => (query ? setQuery("") : open("add"))}
              >
                {query ? "検索をクリア" : "最初の作品を追加"}
              </button>
            </div>
          )}
          <footer className="library-footer">
            <span>{visible.length} artworks · A home for every idea.</span>
            <span>
              Made for your next <em>great thing.</em> ✳
            </span>
          </footer>
        </div>
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {modal === "group" && (
        <Dialog title="新しいグループ" onClose={() => setModal(null)}>
          <p className="dialog-intro">
            プロジェクトやチームごとに、作品の居場所をつくりましょう。
          </p>
          <form onSubmit={(e) => submit(e, "group")}>
            <label>
              グループ名
              <input
                name="name"
                required
                maxLength={120}
                autoFocus
                placeholder="例：Spring campaign"
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className="button primary full"
              disabled={busy}
            >
              {busy ? "作成中…" : "グループを作成"}
            </button>
          </form>
        </Dialog>
      )}
      {modal === "add" && (
        <Dialog title="作品を追加" onClose={() => setModal(null)}>
          {user && (
            <UploadPanel
              groups={ownedGroups}
              initialGroup={groupId}
              onUploaded={(art) => {
                setData((d) => ({
                  ...d,
                  artworks: [art, ...d.artworks.filter((a) => a.id !== art.id)],
                }));
              }}
            />
          )}
          {!user && (
            <p className="field-note">
              画像のアップロードはGoogleログイン後に利用できます。
            </p>
          )}
          <details className="upload-alternatives">
            <summary>その他の追加方法</summary>
            <button className="drive-option" onClick={openDrive}>
              <DriveIcon />
              Google Driveから取り込む
              <ArrowUpRight size={16} />
            </button>
            <details className="url-add">
              <summary>画像URLから追加</summary>
              <form onSubmit={(e) => submit(e, "add")}>
                <label>
                  タイトル
                  <input
                    name="title"
                    required
                    maxLength={120}
                    placeholder="作品のタイトル"
                  />
                </label>
                <label>
                  画像URL
                  <input
                    name="url"
                    type="url"
                    required
                    pattern="https://.*"
                    placeholder="https://…"
                  />
                </label>
                <div className="form-row">
                  <label>
                    グループ
                    <select
                      name="groupId"
                      defaultValue={
                        groupId === "all"
                          ? (data.groups.find((g) => g.ownerId === user?.id)
                              ?.id ?? "")
                          : groupId
                      }
                    >
                      {ownedGroups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    コレクション
                    <input
                      name="collection"
                      required
                      maxLength={120}
                      defaultValue="Unsorted"
                      list="collections"
                    />
                  </label>
                </div>
                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  className="button primary full"
                  disabled={busy}
                >
                  {busy ? "追加中…" : "作品を追加"}
                </button>
              </form>
            </details>
          </details>
        </Dialog>
      )}
      {modal === "settings" && (
        <Dialog title="Workspace settings" onClose={() => setModal(null)}>
          <p className="dialog-intro">{user?.email ?? "デモモード"}</p>
          <p className="field-note">
            Driveの接続はあなた専用です。共有したグループの作品だけがメンバーに表示されます。
          </p>
          {user && (
            <button
              className="button secondary full"
              onClick={async () => {
                try {
                  await request("/session", { method: "DELETE" });
                  setAuthToken("");
                  clearDriveCaches();
                  setData({ groups: [], artworks: [] });
                  setUser(null);
                  setConnected(false);
                  setDemoAllowed(false);
                  setModal(null);
                  setMode("demo");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              ログアウト
            </button>
          )}
          {error && <p className="error">{error}</p>}
          {user && <GroupSharing groups={data.groups} userId={user.id} />}
          <div className="connection-info">
            <DriveIcon />
            <span>
              Google Drive
              <strong>
                {connected
                  ? "接続済み"
                  : configured
                    ? "接続できます"
                    : "OAuth認証情報が未設定です"}
              </strong>
            </span>
            {connected && (
              <button
                className="text-button"
                onClick={async () => {
                  try {
                    await request("/drive", { method: "DELETE" });
                    setConnected(false);
                    clearDriveCaches();
                    notify("Driveの接続を解除しました");
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                接続解除
              </button>
            )}
          </div>
        </Dialog>
      )}
      {modal === "drive" && (
        <Dialog
          title="Google Driveから取り込む"
          onClose={() => setModal(null)}
          wide={connected}
        >
          {!connected ? (
            <div className="connect-panel">
              <div className="drive-large">
                <DriveIcon />
              </div>
              <h3>アイデアを、連れてこよう。</h3>
              <p>
                Google Driveの画像を選んで、グループに整理。
                <br />
                元のファイルはそのまま、大切に。
              </p>
              {(!configured || mode === "demo") && (
                <div className="setup-note">
                  Drive接続にはAPIの起動とGoogle
                  OAuth設定が必要です。設定手順はプロジェクトのREADMEをご覧ください。
                </div>
              )}
              <button
                className="button primary full"
                onClick={connect}
                disabled={busy || mode !== "live" || !configured}
              >
                {busy ? "接続中…" : "Googleアカウントを接続"}
              </button>
              <small>
                接続したDriveはあなただけが閲覧できます。グループに取り込んだ作品だけが、そのグループのメンバーに共有されます。
              </small>
            </div>
          ) : (
            <>
              <div className="drive-toolbar">
                <button
                  className="button secondary"
                  onClick={() => driveFiles()}
                >
                  <ArrowLeft size={15} />
                  すべてのファイル
                </button>
                <label>
                  取り込み先
                  <select
                    value={importGroup}
                    onChange={(e) => setImportGroup(e.target.value)}
                  >
                    {ownedGroups.map((g) => (
                      <option value={g.id} key={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="icon"
                  aria-label="再読み込み"
                  onClick={() => driveFiles(folder, undefined, true)}
                  disabled={busy}
                >
                  <RefreshCw size={17} />
                </button>
              </div>
              <div className="drive-files">
                {files.map((f) => (
                  <button
                    className={
                      chosenSet.has(f.id) ? "drive-file chosen" : "drive-file"
                    }
                    key={f.id}
                    onClick={() =>
                      f.mimeType.endsWith("folder")
                        ? driveFiles(f.id)
                        : setChosen(
                            chosenSet.has(f.id)
                              ? chosen.filter((id) => id !== f.id)
                              : [...chosen, f.id],
                          )
                    }
                  >
                    {f.mimeType.endsWith("folder") ? (
                      <Folder size={35} />
                    ) : f.thumbnailUrl ? (
                      <DriveThumbnail path={f.thumbnailUrl} alt={f.name} />
                    ) : (
                      <ImageIcon size={35} />
                    )}
                    <span>{f.name}</span>
                    {chosenSet.has(f.id) && <Check size={16} />}
                  </button>
                ))}
              </div>
              {!files.length && !busy && (
                <p className="dialog-intro">
                  このフォルダには画像がありません。
                </p>
              )}
              {pageToken && (
                <button
                  className="text-button"
                  onClick={() => driveFiles(folder, pageToken)}
                  disabled={busy}
                >
                  さらに読み込む
                </button>
              )}
              <button
                className="button primary full"
                disabled={!chosen.length || busy}
                onClick={importFiles}
              >
                {busy ? "読み込み中…" : `${chosen.length}点を取り込む`}
              </button>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
      {selected && (
        <ArtworkViewer
          art={selected}
          index={selectedIndex}
          count={visible.length}
          onNavigate={navigateArtwork}
          onClose={() => setSelected(null)}
          onCopy={() => copyImage(selected)}
          copying={copyingId !== null}
          feedback={toast}
        >
          <form key={selected.id} onSubmit={(e) => submit(e, "edit")}>
            <span className="eyebrow">
              {selected.source === "drive"
                ? "FROM GOOGLE DRIVE"
                : selected.source === "storage"
                  ? "FOLIO CLOUD STORAGE"
                  : "YOUR INSPIRATION"}
            </span>
            <label>
              タイトル
              <input
                name="title"
                readOnly={!canEditSelected}
                defaultValue={selected.title}
                required
                maxLength={120}
              />
            </label>
            <label>
              グループ
              <select
                name="groupId"
                disabled={!canEditSelected}
                defaultValue={selected.groupId}
              >
                {(canEditSelected
                  ? ownedGroups
                  : data.groups.filter((g) => g.id === selected.groupId)
                ).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              コレクション
              <input
                name="collection"
                readOnly={!canEditSelected}
                defaultValue={selected.collection}
                required
                maxLength={120}
                list="collections"
              />
            </label>
            <label>
              タグ（カンマ区切り）
              <input
                name="tags"
                readOnly={!canEditSelected}
                defaultValue={selected.tags.join(", ")}
                maxLength={500}
              />
            </label>
            <p className="field-note">
              追加日：
              {new Date(selected.createdAt).toLocaleDateString("ja-JP")}
            </p>
            <button
              type="submit"
              className="button primary full"
              disabled={busy || !canEditSelected}
            >
              {!canEditSelected
                ? "共有作品（閲覧のみ）"
                : busy
                  ? "保存中…"
                  : "変更を保存"}
            </button>

            <div className="detail-actions">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  change(selected, { favorite: !selected.favorite })
                }
              >
                <Heart
                  size={15}
                  fill={selected.favorite ? "currentColor" : "none"}
                />
                お気に入り
              </button>
              <button
                type="button"
                className="text-button danger"
                disabled={!canEditSelected}
                onClick={async () => {
                  if (
                    !window.confirm(
                      "この作品をライブラリから削除しますか？Driveの元ファイルは削除されません。",
                    )
                  )
                    return;
                  try {
                    if (mode === "live")
                      await request(`/artworks/${selected.id}`, {
                        method: "DELETE",
                      });
                    update({
                      ...data,
                      artworks: data.artworks.filter(
                        (a) => a.id !== selected.id,
                      ),
                    });
                    setSelected(null);
                    notify("ライブラリから削除しました");
                  } catch (e) {
                    notify((e as Error).message);
                  }
                }}
              >
                <Trash2 size={15} />
                削除
              </button>
            </div>
          </form>
        </ArtworkViewer>
      )}
      <datalist id="collections">
        {collections.map((c) => (
          <option value={c} key={c} />
        ))}
      </datalist>
    </div>
  );
}
