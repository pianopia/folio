import React, { useEffect, useState } from "react";
import {
  SafeAreaView,
  StatusBar,
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  Image,
  StyleSheet,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as Crypto from "expo-crypto";
import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  initialArtworks,
  initialGroups,
  type Artwork,
  type Group,
} from "@folio/shared";

type Data = { artworks: Artwork[]; groups: Group[] };
const initial = { artworks: initialArtworks, groups: initialGroups };
export default function App() {
  const [data, setData] = useState<Data>(initial),
    [api, setApi] = useState("http://localhost:3001"),
    [token, setToken] = useState(""),
    [ready, setReady] = useState(false),
    [mode, setMode] = useState("demo"),
    [query, setQuery] = useState(""),
    [group, setGroup] = useState("all"),
    [tab, setTab] = useState("all"),
    [modal, setModal] = useState<"settings" | "group" | "add" | "drive" | null>(
      null
    ),
    [selected, setSelected] = useState<Artwork | null>(null),
    [title, setTitle] = useState(""),
    [url, setUrl] = useState(""),
    [collection, setCollection] = useState("Unsorted"),
    [target, setTarget] = useState("studio"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [files, setFiles] = useState<
      { id: string; name: string; mimeType: string }[]
    >([]),
    [chosen, setChosen] = useState<string[]>([]),
    [nextPage, setNextPage] = useState<string | undefined>(),
    [folder, setFolder] = useState("");
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (!copyStatus) return;
    const timer = setTimeout(() => setCopyStatus(""), 3500);
    return () => clearTimeout(timer);
  }, [copyStatus]);
  async function copyImage(art: Artwork) {
    if (copyingId) return;
    setCopyingId(art.id);
    try {
      const isDrive = art.source === "drive";
      const response = await fetch(isDrive ? `${api}${art.url}` : art.url, {
        headers: isDrive && token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw Error("画像を取得できませんでした。");
      const blob = await response.blob();
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(Error("画像を読み込めませんでした。"));
        reader.onload = () => {
          const result = reader.result;
          if (typeof result !== "string" || !result.includes(","))
            reject(Error("画像を読み込めませんでした。"));
          else resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.readAsDataURL(blob);
      });
      await Clipboard.setImageAsync(base64);
      setCopyStatus("画像をコピーしました");
    } catch (error) {
      Alert.alert(
        "コピーできませんでした",
        error instanceof Error
          ? error.message
          : "画像の接続状態を確認してください。"
      );
    } finally {
      setCopyingId(null);
    }
  }
  const [draftApi, setDraftApi] = useState(api);
  const [draftToken, setDraftToken] = useState(token);
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const r = await fetch(`${api}/api${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw Error(b.error ?? `API error (${r.status})`);
    }
    return r.status === 204 ? (undefined as T) : r.json();
  }
  useEffect(() => {
    (async () => {
      const [a, t, d] = await Promise.all([
        AsyncStorage.getItem("folio-api"),
        SecureStore.getItemAsync("folio-token"),
        AsyncStorage.getItem("folio-demo"),
      ]);
      if (a) setApi(a);
      if (t) setToken(t);
      if (d) setData(JSON.parse(d));
      setReady(true);
    })().catch(() => setReady(true));
  }, []);
  async function load() {
    try {
      setData(await request<Data>("/library"));
      setMode("live");
    } catch {
      setMode("demo");
    }
  }
  useEffect(() => {
    if (ready) void load();
  }, [ready, api, token]);
  async function update(d: Data) {
    setData(d);
    if (mode === "demo")
      await AsyncStorage.setItem("folio-demo", JSON.stringify(d));
  }
  function open(m: typeof modal) {
    if (m === "settings") {
      setDraftApi(api);
      setDraftToken(token);
    }
    if (m === "drive") setChosen([]);
    setModal(m);
    setError("");
    setTitle("");
    setUrl("");
    setCollection("Unsorted");
    setTarget(group === "all" ? data.groups[0]?.id : group);
  }
  async function patch(a: Artwork, b: Partial<Artwork>) {
    try {
      const next =
        mode === "demo"
          ? { ...a, ...b }
          : await request<Artwork>(`/artworks/${a.id}`, {
              method: "PATCH",
              body: JSON.stringify(b),
            });
      await update({
        ...data,
        artworks: data.artworks.map((x) => (x.id === a.id ? next : x)),
      });
      if (selected?.id === a.id) setSelected(next);
    } catch (e) {
      Alert.alert("保存できませんでした", (e as Error).message);
    }
  }
  async function save() {
    if (!title.trim()) {
      setError("名前を入力してください");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (modal === "group") {
        const g =
          mode === "demo"
            ? { id: Crypto.randomUUID(), name: title.trim(), color: "#9b9be8" }
            : await request<Group>("/groups", {
                method: "POST",
                body: JSON.stringify({ name: title }),
              });
        await update({ ...data, groups: [...data.groups, g] });
        setGroup(g.id);
      } else {
        if (!/^https:\/\//.test(url))
          throw Error("HTTPSの画像URLを入力してください");
        const a =
          mode === "demo"
            ? ({
                id: Crypto.randomUUID(),
                title: title.trim(),
                groupId: target,
                collection: collection.trim() || "Unsorted",
                url,
                tags: [],
                favorite: false,
                source: "sample",
                createdAt: new Date().toISOString(),
              } as Artwork)
            : await request<Artwork>("/artworks", {
                method: "POST",
                body: JSON.stringify({
                  title,
                  url,
                  groupId: target,
                  collection,
                }),
              });
        await update({ ...data, artworks: [a, ...data.artworks] });
      }
      setModal(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function drive(folderId = "", page?: string) {
    setBusy(true);
    setError("");
    try {
      const s = await request<{ connected: boolean; configured: boolean }>(
        "/drive/status"
      );
      if (!s.connected)
        throw Error(
          "WebからGoogle Driveを接続してから、この画面を再読み込みしてください。"
        );
      const r = await request<{ files: typeof files; nextPageToken?: string }>(
        `/drive/files?${new URLSearchParams({
          ...(folderId ? { folder: folderId } : {}),
          ...(page ? { pageToken: page } : {}),
        })}`
      );
      setFiles((prev) => (page ? [...prev, ...r.files] : r.files));
      setFolder(folderId);
      setNextPage(r.nextPageToken);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const artworks = data.artworks.filter(
    (a) =>
      (group === "all" || a.groupId === group) &&
      (tab !== "favorites" || a.favorite) &&
      `${a.title} ${a.tags.join(" ")} ${a.collection}`
        .toLowerCase()
        .includes(query.toLowerCase())
  );
  const selectedIndex = selected
    ? artworks.findIndex((a) => a.id === selected.id)
    : -1;
  function navigateArtwork(direction: number) {
    if (selectedIndex < 0 || artworks.length < 2) return;
    const next =
      artworks[(selectedIndex + direction + artworks.length) % artworks.length];
    setSelected(next);
    setTitle(next.title);
    setTarget(next.groupId);
    setCollection(next.collection);
    setError("");
  }
  const picture = (a: Artwork, size = 512) => ({
    uri:
      a.source === "drive"
        ? `${api}/api/drive/thumbnail/${encodeURIComponent(
            a.driveId ?? a.url.split("/").pop()!
          )}?size=${size}`
        : a.url,
    headers:
      a.source === "drive" && token
        ? { Authorization: `Bearer ${token}` }
        : undefined,
  });
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={s.header}>
        <Text style={s.logo}>
          folio<Text style={s.star}>✳</Text>
        </Text>
        <Pressable
          accessibilityLabel="設定"
          onPress={() => open("settings")}
          style={s.avatar}
        >
          <Text style={s.avatarText}>S</Text>
        </Pressable>
      </View>
      <FlatList
        data={artworks}
        numColumns={2}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={5}
        keyExtractor={(a) => a.id}
        contentContainerStyle={s.content}
        columnWrapperStyle={s.columns}
        refreshing={busy}
        onRefresh={async () => {
          setBusy(true);
          await load();
          setBusy(false);
        }}
        ListHeaderComponent={
          <>
            <View style={s.hero}>
              <Text style={s.eyebrow}>A LITTLE SPACE FOR BIG IDEAS</Text>
              <Text style={s.heroTitle}>
                Your creative world,{String.fromCharCode(10)}all in one place.
              </Text>
              <Text style={s.heroNote}>
                ひらめきも、つくったものも。ひとつの場所に。
              </Text>
              <Pressable
                onPress={() => {
                  open("drive");
                  void drive();
                }}
              >
                <Text style={s.heroLink}>Google Driveから取り込む ↗</Text>
              </Pressable>
              <Text style={s.heroStar}>✳</Text>
            </View>
            <View style={s.titleRow}>
              <Text style={s.heading}>
                {tab === "favorites" ? "Favorites" : "All artworks"}{" "}
                <Text style={s.subtle}>{artworks.length}</Text>
              </Text>
              <Pressable style={s.add} onPress={() => open("add")}>
                <Text style={s.addText}>＋ 作品を追加</Text>
              </Pressable>
            </View>
            <TextInput
              accessibilityLabel="作品を検索"
              style={s.search}
              placeholder="⌕  Search your inspiration…"
              value={query}
              onChangeText={setQuery}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={s.chips}
            >
              <Pressable
                style={[s.chip, group === "all" && s.chipActive]}
                onPress={() => setGroup("all")}
              >
                <Text style={s.chipText}>すべて</Text>
              </Pressable>
              {data.groups.map((g) => (
                <Pressable
                  key={g.id}
                  style={[s.chip, group === g.id && s.chipActive]}
                  onPress={() => setGroup(g.id)}
                >
                  <Text style={s.chipText}>▪ {g.name}</Text>
                </Pressable>
              ))}
              <Pressable style={s.chip} onPress={() => open("group")}>
                <Text style={s.chipText}>＋ グループ</Text>
              </Pressable>
            </ScrollView>
            {mode === "demo" && (
              <Text style={s.demo}>
                Demo mode · 変更はこの端末に保存されます
              </Text>
            )}
          </>
        }
        renderItem={({ item: a, index }) => (
          <View style={s.card}>
            <Pressable
              onPress={() => {
                setSelected(a);
                setTitle(a.title);
                setTarget(a.groupId);
                setCollection(a.collection);
                setError("");
              }}
            >
              <Image
                source={picture(a)}
                style={[s.image, { height: index % 3 === 0 ? 230 : 190 }]}
                accessibilityLabel={a.title}
              />
            </Pressable>
            <Pressable
              accessibilityLabel={`${a.title}の画像をコピー`}
              style={[s.heart, { right: 42 }]}
              disabled={copyingId !== null}
              onPress={() => copyImage(a)}
            >
              {copyingId === a.id ? (
                <ActivityIndicator size="small" color="#58704b" />
              ) : (
                <Text style={{ color: "#58704b" }}>⧉</Text>
              )}
            </Pressable>
            <Pressable
              accessibilityLabel="お気に入り切り替え"
              style={s.heart}
              onPress={() => patch(a, { favorite: !a.favorite })}
            >
              <Text style={{ color: a.favorite ? "#58704b" : "#8b9684" }}>
                {a.favorite ? "♥" : "♡"}
              </Text>
            </Pressable>
            <Text style={s.artTitle}>{a.title}</Text>
            <Text style={s.artMeta}>
              {data.groups.find((g) => g.id === a.groupId)?.name} ·{" "}
              {a.collection}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <View style={s.empty}>
            <Text>
              作品がありません。検索条件を変えるか、作品を追加してください。
            </Text>
          </View>
        }
      />
      {!!copyStatus && (
        <Text
          accessibilityRole="alert"
          style={{
            padding: 12,
            backgroundColor: "#e5eddc",
            color: "#3b5832",
            textAlign: "center",
          }}
        >
          {copyStatus}
        </Text>
      )}
      <View style={s.bottom}>
        <Pressable onPress={() => setTab("all")}>
          <Text style={[s.navText, tab === "all" && s.navActive]}>
            ▦ Library
          </Text>
        </Pressable>
        <Pressable onPress={() => setTab("favorites")}>
          <Text style={[s.navText, tab === "favorites" && s.navActive]}>
            ♡ Favorites
          </Text>
        </Pressable>
        <Pressable
          onPress={() => {
            open("drive");
            void drive();
          }}
        >
          <Text style={s.navText}>△ Drive</Text>
        </Pressable>
      </View>
      <Modal
        visible={!!modal || !!selected}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          setModal(null);
          setSelected(null);
        }}
      >
        <SafeAreaView style={s.safe}>
          <ScrollView contentContainerStyle={s.modal}>
            <View style={s.titleRow}>
              <Text style={s.heading}>
                {selected
                  ? "Artwork details"
                  : modal === "settings"
                  ? "Settings"
                  : modal === "group"
                  ? "グループを作成"
                  : modal === "drive"
                  ? "Google Drive"
                  : "作品を追加"}
              </Text>
              <Pressable
                accessibilityLabel="閉じる"
                onPress={() => {
                  setModal(null);
                  setSelected(null);
                }}
              >
                <Text style={s.close}>×</Text>
              </Pressable>
            </View>
            {modal === "settings" ? (
              <>
                <Text style={s.label}>API URL</Text>
                <TextInput
                  style={s.input}
                  value={draftApi}
                  onChangeText={setDraftApi}
                  autoCapitalize="none"
                  keyboardType="url"
                />
                <Text style={s.help}>
                  実機ではPCのLAN IPアドレスまたはHTTPSのAPI
                  URLを指定します。Androidエミュレーターは10.0.2.2を使用します。
                </Text>
                <Text style={s.label}>API token</Text>
                <TextInput
                  style={s.input}
                  value={draftToken}
                  onChangeText={setDraftToken}
                  secureTextEntry
                  autoCapitalize="none"
                />
                <Pressable
                  style={s.primary}
                  onPress={async () => {
                    try {
                      const parsed = new URL(draftApi);
                      if (!["http:", "https:"].includes(parsed.protocol))
                        throw Error();
                    } catch {
                      setError("有効なAPI URLを入力してください");
                      return;
                    }
                    const endpoint = draftApi.replace(/\/$/, "");
                    await AsyncStorage.setItem("folio-api", endpoint);
                    await SecureStore.setItemAsync("folio-token", draftToken);
                    setApi(endpoint);
                    setToken(draftToken);
                    setModal(null);
                  }}
                >
                  <Text style={s.primaryText}>保存して接続</Text>
                </Pressable>
              </>
            ) : modal === "drive" ? (
              <>
                <Text style={s.help}>
                  Web側で接続したDriveから画像を選べます。フォルダをタップすると中を表示します。
                </Text>
                <GroupPicker
                  groups={data.groups}
                  value={target}
                  onChange={setTarget}
                />
                <Pressable onPress={() => drive()}>
                  <Text style={s.link}>← すべてのファイル・再読み込み</Text>
                </Pressable>
                {files.map((f) => (
                  <Pressable
                    key={f.id}
                    style={s.file}
                    onPress={() =>
                      f.mimeType.endsWith("folder")
                        ? drive(f.id)
                        : setChosen(
                            chosen.includes(f.id)
                              ? chosen.filter((id) => id !== f.id)
                              : [...chosen, f.id]
                          )
                    }
                  >
                    <Text>
                      {f.mimeType.endsWith("folder") ? "▱" : "▧"} {f.name}
                    </Text>
                    <Text>{chosen.includes(f.id) ? "✓" : ""}</Text>
                  </Pressable>
                ))}
                {nextPage && (
                  <Pressable onPress={() => drive(folder, nextPage)}>
                    <Text style={s.link}>さらに読み込む</Text>
                  </Pressable>
                )}
                <Pressable
                  disabled={busy || !chosen.length}
                  style={[s.primary, (!chosen.length || busy) && s.disabled]}
                  onPress={async () => {
                    setBusy(true);
                    try {
                      await request("/drive/import", {
                        method: "POST",
                        body: JSON.stringify({ ids: chosen, groupId: target }),
                      });
                      await load();
                      setChosen([]);
                      setModal(null);
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <Text style={s.primaryText}>{chosen.length}点を取り込む</Text>
                </Pressable>
              </>
            ) : (
              <>
                {selected && (
                  <View>
                    <View
                      style={{
                        flexDirection: "row",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 12,
                      }}
                    >
                      <Pressable
                        accessibilityLabel="前の作品"
                        disabled={artworks.length < 2}
                        onPress={() => navigateArtwork(-1)}
                        hitSlop={12}
                      >
                        <Text style={s.link}>← 前の作品</Text>
                      </Pressable>
                      <Text style={s.help}>
                        {selectedIndex + 1} / {artworks.length}
                      </Text>
                      <Pressable
                        accessibilityLabel="次の作品"
                        disabled={artworks.length < 2}
                        onPress={() => navigateArtwork(1)}
                        hitSlop={12}
                      >
                        <Text style={s.link}>次の作品 →</Text>
                      </Pressable>
                    </View>
                    <Image
                      key={selected.id}
                      source={picture(selected, 1024)}
                      style={s.detailImage}
                    />
                    <Pressable
                      style={s.primary}
                      disabled={copyingId !== null}
                      onPress={() => copyImage(selected)}
                    >
                      <Text style={s.primaryText}>
                        {copyingId === selected.id
                          ? "コピー中…"
                          : "⧉ 画像をコピー"}
                      </Text>
                    </Pressable>
                  </View>
                )}
                <Text style={s.label}>
                  {modal === "group" ? "グループ名" : "タイトル"}
                </Text>
                <TextInput
                  style={s.input}
                  value={title}
                  onChangeText={setTitle}
                  maxLength={120}
                />
                {modal !== "group" && (
                  <>
                    <Text style={s.label}>グループ</Text>
                    <GroupPicker
                      groups={data.groups}
                      value={target}
                      onChange={setTarget}
                    />
                    <Text style={s.label}>コレクション</Text>
                    <TextInput
                      style={s.input}
                      value={collection}
                      onChangeText={setCollection}
                      maxLength={120}
                    />
                    {!selected && (
                      <>
                        <Text style={s.label}>画像URL（HTTPS）</Text>
                        <TextInput
                          style={s.input}
                          value={url}
                          onChangeText={setUrl}
                          autoCapitalize="none"
                          keyboardType="url"
                        />
                      </>
                    )}
                  </>
                )}
                <Pressable
                  disabled={busy}
                  style={s.primary}
                  onPress={
                    selected
                      ? async () => {
                          if (!title.trim() || !collection.trim()) {
                            setError(
                              "タイトルとコレクションを入力してください"
                            );
                            return;
                          }
                          setBusy(true);
                          try {
                            const a =
                              mode === "demo"
                                ? {
                                    ...selected,
                                    title,
                                    groupId: target,
                                    collection,
                                  }
                                : await request<Artwork>(
                                    `/artworks/${selected.id}`,
                                    {
                                      method: "PATCH",
                                      body: JSON.stringify({
                                        title,
                                        groupId: target,
                                        collection,
                                      }),
                                    }
                                  );
                            await update({
                              ...data,
                              artworks: data.artworks.map((x) =>
                                x.id === a.id ? a : x
                              ),
                            });
                            setSelected(null);
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }
                      : save
                  }
                >
                  <Text style={s.primaryText}>
                    {busy ? "保存中…" : "保存する"}
                  </Text>
                </Pressable>
                {selected && (
                  <Pressable
                    onPress={() =>
                      Alert.alert(
                        "作品を削除",
                        "Driveの元ファイルは削除されません。",
                        [
                          { text: "キャンセル", style: "cancel" },
                          {
                            text: "削除",
                            style: "destructive",
                            onPress: async () => {
                              try {
                                if (mode === "live")
                                  await request(`/artworks/${selected.id}`, {
                                    method: "DELETE",
                                  });
                                await update({
                                  ...data,
                                  artworks: data.artworks.filter(
                                    (a) => a.id !== selected.id
                                  ),
                                });
                                setSelected(null);
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            },
                          },
                        ]
                      )
                    }
                  >
                    <Text style={s.delete}>ライブラリから削除</Text>
                  </Pressable>
                )}
              </>
            )}
            {busy && (
              <ActivityIndicator color="#466042" style={{ marginTop: 16 }} />
            )}
            {!!error && (
              <Text accessibilityRole="alert" style={s.error}>
                {error}
              </Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
function GroupPicker({
  groups,
  value,
  onChange,
}: {
  groups: Group[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      style={s.chips}
      showsHorizontalScrollIndicator={false}
    >
      {groups.map((g) => (
        <Pressable
          key={g.id}
          style={[s.chip, value === g.id && s.chipActive]}
          onPress={() => onChange(g.id)}
        >
          <Text style={s.chipText}>{g.name}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fafbf8" },
  header: {
    paddingHorizontal: 23,
    paddingVertical: 13,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: "#e9ede3",
  },
  logo: {
    fontSize: 36,
    letterSpacing: -2,
    fontWeight: "800",
    color: "#303c2b",
  },
  star: { color: "#779568", fontSize: 33 },
  avatar: {
    width: 35,
    height: 35,
    borderRadius: 20,
    backgroundColor: "#e4eada",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#7e8e6d", fontSize: 18 },
  content: { padding: 20, paddingBottom: 35 },
  columns: { gap: 14, alignItems: "flex-start" },
  hero: {
    padding: 25,
    backgroundColor: "#eaf0e2",
    borderRadius: 12,
    marginBottom: 29,
    overflow: "hidden",
  },
  eyebrow: { fontSize: 8, color: "#8a9a7c", letterSpacing: 1.3 },
  heroTitle: {
    fontSize: 29,
    letterSpacing: -1.1,
    lineHeight: 36,
    color: "#35452c",
    marginTop: 18,
  },
  heroNote: { fontSize: 9, color: "#8a997b", marginTop: 12 },
  heroLink: {
    fontSize: 10,
    color: "#516843",
    marginTop: 20,
    fontWeight: "600",
  },
  heroStar: {
    position: "absolute",
    fontSize: 105,
    color: "#acbd94",
    right: -8,
    bottom: -28,
    transform: [{ rotate: "15deg" }],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 19,
  },
  heading: {
    fontSize: 23,
    letterSpacing: -0.7,
    fontWeight: "600",
    color: "#38482f",
  },
  subtle: { fontSize: 13, color: "#9aa88c" },
  add: {
    backgroundColor: "#3c5835",
    borderRadius: 6,
    paddingVertical: 11,
    paddingHorizontal: 12,
  },
  addText: { color: "#fff", fontSize: 10, fontWeight: "500" },
  search: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e1e8d8",
    borderRadius: 7,
    padding: 13,
    fontSize: 12,
    color: "#6f815f",
  },
  chips: { marginVertical: 15, maxHeight: 40 },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginRight: 5,
  },
  chipActive: { backgroundColor: "#e5eddc" },
  chipText: { fontSize: 10, color: "#7b8d6b" },
  demo: { fontSize: 9, color: "#a1ad94", marginBottom: 15 },
  card: { flex: 1, maxWidth: "49%", position: "relative", marginBottom: 23 },
  image: { width: "100%", backgroundColor: "#e7edde", borderRadius: 8 },
  heart: {
    position: "absolute",
    right: 8,
    top: 8,
    width: 28,
    height: 28,
    borderRadius: 20,
    backgroundColor: "#fffffff0",
    alignItems: "center",
    justifyContent: "center",
  },
  artTitle: {
    fontSize: 12,
    color: "#435238",
    fontWeight: "500",
    marginTop: 10,
  },
  artMeta: { fontSize: 8, color: "#9caa8f", marginTop: 5, lineHeight: 13 },
  bottom: {
    flexDirection: "row",
    justifyContent: "space-around",
    borderTopWidth: 1,
    borderColor: "#e0e7d8",
    padding: 19,
    backgroundColor: "#f7f9f3",
  },
  navText: { fontSize: 11, color: "#9ba98e" },
  navActive: { color: "#446139", fontWeight: "600" },
  modal: { padding: 25, paddingBottom: 60 },
  close: { fontSize: 33, color: "#a0ad92" },
  label: { fontSize: 11, color: "#7f926d", marginTop: 17, marginBottom: 8 },
  input: {
    borderWidth: 1,
    borderColor: "#dce5d2",
    borderRadius: 6,
    padding: 13,
    fontSize: 13,
    color: "#4b613b",
    backgroundColor: "#fff",
  },
  help: {
    fontSize: 11,
    color: "#a0ad92",
    lineHeight: 20,
    marginTop: 14,
    marginBottom: 10,
  },
  primary: {
    backgroundColor: "#3b5832",
    padding: 15,
    borderRadius: 7,
    alignItems: "center",
    marginTop: 23,
  },
  primaryText: { color: "#fff", fontSize: 12, fontWeight: "500" },
  detailImage: {
    width: "100%",
    height: 280,
    borderRadius: 9,
    resizeMode: "contain",
    backgroundColor: "#eaf0e2",
  },
  delete: {
    fontSize: 11,
    color: "#b58973",
    marginTop: 22,
    textAlign: "center",
  },
  error: {
    backgroundColor: "#f9e9e1",
    color: "#a16d50",
    fontSize: 12,
    lineHeight: 21,
    padding: 14,
    marginTop: 20,
    borderRadius: 6,
  },
  link: { color: "#7c9466", fontSize: 11, marginVertical: 12 },
  file: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: "#e2e9d9",
    flexDirection: "row",
    justifyContent: "space-between",
  },
  disabled: { opacity: 0.4 },
  empty: { padding: 30, alignItems: "center" },
});
