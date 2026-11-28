import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, AppState, Image, Linking, Modal, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Directory, File, Paths } from "expo-file-system";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Crypto from "expo-crypto";
import type { Artwork, Group } from "@folio/shared";
import { BurstQueue, type BurstItem } from "./burstQueue";

const KEY = "folio-burst-queue-v1";
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const bytesLabel = (n: number) => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)}GB` : `${(n / 1024 ** 2).toFixed(0)}MB`;

export default function BurstCamera({ api, token, groups, onUploaded, onClose }: {
  api: string; token: string; groups: Group[]; onUploaded: (art: Artwork) => void; onClose: () => void;
}) {
  const [groupId, setGroupId] = useState("");
  const [permission, requestPermission] = useCameraPermissions();
  const [items, setItems] = useState<BurstItem[]>([]);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [cameraReady, setCameraReady] = useState(false);
  const [sizeReady, setSizeReady] = useState(false);
  const [pictureSize, setPictureSize] = useState<string>();
  const [showQueue, setShowQueue] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [captureError, setCaptureError] = useState("");
  const camera = useRef<CameraView>(null);
  const captureLock = useRef(false);
  const directory = useMemo(() => new Directory(Paths.document, "burst-uploads"), []);
  const queueRef = useRef<BurstQueue | null>(null);
  if (!queueRef.current) queueRef.current = new BurstQueue({
    storage: { get: () => AsyncStorage.getItem(KEY), set: (value) => AsyncStorage.setItem(KEY, value) },
    files: { exists: async (uri) => new File(uri).exists, remove: async (uri) => { const f = new File(uri); if (f.exists) f.delete(); } },
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    online: () => onlineRef.current,
    onChange: setItems,
    upload: async (item) => {
      try {
        const form = new FormData();
        form.append("file", { uri: item.uri, name: item.filename, type: "image/jpeg" } as unknown as Blob);
        form.append("groupId", item.groupId);
        form.append("collection", `撮影モード ${new Date(item.createdAt).toLocaleDateString("ja-JP")}`);
        const response = await fetch(`${api}/api/artworks/upload`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, signal: AbortSignal.timeout(100000) });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return { ok: false as const, status: response.status, message: body.error || body.message || "アップロードできませんでした" };
        onUploaded(body as Artwork);
        return { ok: true as const };
      } catch (error) {
        setOnline(false);
        return { ok: false as const, message: (error as Error).message || "通信に失敗しました", retryable: true };
      }
    },
  });
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const queue = queueRef.current;
  const counts = { wait: items.filter((x) => x.status === "待機").length, sending: items.filter((x) => x.status === "送信中").length, done: items.filter((x) => x.status === "完了").length, failed: items.filter((x) => x.status === "失敗").length };
  const pendingBytes = items.filter((x) => x.status === "待機" || x.status === "送信中" || x.status === "失敗").reduce((n, x) => n + x.size, 0);

  useEffect(() => { void queue.restore().then(() => { setReady(true); queue.resume(); }); }, [queue]);
  useEffect(() => {
    let active = true;
    const probe = async () => {
      try { const r = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(5000) }); if (active && r.ok) { onlineRef.current = true; setOnline(true); queue.resume(); } }
      catch { if (active) { onlineRef.current = false; setOnline(false); } }
    };
    void probe(); const timer = setInterval(() => { if (AppState.currentState === "active") void probe(); }, 15000);
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") void probe(); });
    return () => { active = false; clearInterval(timer); sub.remove(); };
  }, [api, queue]);
  useEffect(() => {
    if (!cameraReady || !camera.current) return;
    void camera.current.getAvailablePictureSizesAsync().then((sizes) => {
      const eligible = sizes.map((s) => ({ s, dimensions: s.match(/(\d+)x(\d+)/) })).map(({ s, dimensions }) => ({ s, pixels: dimensions ? Number(dimensions[1]) * Number(dimensions[2]) : 0 })).filter((x) => x.pixels > 0 && x.pixels <= MAX_PIXELS).sort((a, b) => b.pixels - a.pixels);
      if (eligible[0]) { setPictureSize(eligible[0].s); setSizeReady(true); }
    }).catch(() => {});
  }, [cameraReady]);

  async function shoot() {
    if (!camera.current || !cameraReady || !sizeReady || captureLock.current) return;
    if (Paths.availableDiskSpace < MAX_BYTES + 30 * 1024 * 1024) { setCaptureError("空き容量が少ないため撮影できません。端末の空き容量を確保してください。"); return; }
    setCaptureError("");
    captureLock.current = true; setCapturing(true);
    try {
      const picture = await camera.current.takePictureAsync({ quality: 1, exif: false, skipProcessing: false, shutterSound: false });
      if (!picture) throw Error("写真を撮影できませんでした。");
      // Release the shutter as soon as the camera finishes. Queue persistence/copying
      // runs independently so neither upload nor storage latency serializes shots.
      captureLock.current = false; setCapturing(false);
      void (async () => {
        try {
          directory.create({ intermediates: true, idempotent: true });
          const id = Crypto.randomUUID(); const filename = `${id}.jpg`;
          const destination = new File(directory, filename);
          await LegacyFileSystem.copyAsync({ from: picture.uri, to: destination.uri });
          await queue.enqueue({ id, groupId, uri: destination.uri, filename, size: destination.size, createdAt: Date.now(), width: picture.width, height: picture.height });
        } catch { setCaptureError("写真を保存できませんでした。端末の空き容量を確認してください。"); }
      })();
    } catch {
      setCaptureError("撮影できませんでした。カメラの状態を確認してください。");
      captureLock.current = false; setCapturing(false);
    }
  }

  const closeButton = <Pressable onPress={onClose} style={{ padding: 12 }}><Text style={{ color: "#fff", fontSize: 18 }}>閉じる</Text></Pressable>;
  return <Modal visible animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={{ flex: 1, backgroundColor: "#182214" }}>
      {!groupId ? <ScrollView contentContainerStyle={{ padding: 22, gap: 14 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>{closeButton}<Text style={{ color: "#fff", fontSize: 20, fontWeight: "700" }}>撮影モード</Text><View style={{ width: 64 }} /></View>
        <Text style={{ color: "#dce6d3", fontSize: 17, marginTop: 22 }}>保存先グループを選択</Text>
        {groups.map((group) => <Pressable key={group.id} onPress={() => setGroupId(group.id)} style={{ backgroundColor: "#34422e", padding: 18, borderRadius: 12 }}><Text style={{ color: "white", fontSize: 17 }}>{group.name}　›</Text></Pressable>)}
        {!groups.length && <Text style={{ color: "#dce6d3" }}>書き込み可能なグループがありません。</Text>}
      </ScrollView> : <View style={{ flex: 1 }}>
        {permission === null ? <View style={{ flex: 1, justifyContent: "center" }}><ActivityIndicator color="white" /></View> : !permission.granted ? <View style={{ flex: 1, padding: 24, justifyContent: "center", gap: 14 }}>
          {closeButton}<Text style={{ color: "white", fontSize: 20 }}>カメラの使用を許可してください</Text>
          <Text style={{ color: "#dce6d3" }}>撮影モードで写真を撮影し、選択した保存先に保存するためにカメラを使用します。</Text>
          {permission?.canAskAgain ? <Pressable onPress={() => void requestPermission()} style={{ padding: 15, backgroundColor: "#759364", borderRadius: 10 }}><Text style={{ color: "white", textAlign: "center" }}>カメラを許可</Text></Pressable> : <Pressable onPress={() => void Linking.openSettings()} style={{ padding: 15, backgroundColor: "#759364", borderRadius: 10 }}><Text style={{ color: "white", textAlign: "center" }}>設定を開く</Text></Pressable>}
        </View> : <>
          <CameraView ref={camera} style={{ flex: 1 }} facing="back" mode="picture" pictureSize={pictureSize} autofocus="off" onCameraReady={() => setCameraReady(true)} onMountError={() => setCameraReady(false)} />
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, padding: 12, flexDirection: "row", justifyContent: "space-between", backgroundColor: "#0008" }}>
            {closeButton}<Text style={{ color: "white", padding: 14 }}>撮影枚数　{items.length}</Text><Pressable onPress={() => setShowQueue(!showQueue)} style={{ padding: 14 }}><Text style={{ color: "white" }}>キュー {showQueue ? "閉じる" : "詳細"}</Text></Pressable>
          </View>
          <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: 16, gap: 10, backgroundColor: "#0009" }}>
            {!online && <Text style={{ color: "#ffd27a", textAlign: "center" }}>オフライン — 接続を確認しています</Text>}
            {!!captureError && <Text style={{ color: "#ffb5a7", textAlign: "center" }}>{captureError}</Text>}
            {cameraReady && !sizeReady && <Text style={{ color: "#ffd27a", textAlign: "center" }}>3200万画素以下の撮影サイズを確認しています…</Text>}
            {pendingBytes > 1024 ** 3 && <Text style={{ color: "#ffd27a", textAlign: "center" }}>未送信の写真が {bytesLabel(pendingBytes)} あります</Text>}
            <Text style={{ color: "white", textAlign: "center" }}>待機 {counts.wait}　送信中 {counts.sending}　完了 {counts.done}　失敗 {counts.failed}</Text>
            <ScrollView horizontal contentContainerStyle={{ gap: 8, justifyContent: "center" }}>{items.slice(-6).reverse().map((item) => <Image key={item.id} source={{ uri: item.uri }} style={{ width: 48, height: 48, borderRadius: 5 }} />)}</ScrollView>
            <Pressable disabled={!cameraReady || !sizeReady || capturing || !ready || Paths.availableDiskSpace < MAX_BYTES + 30 * 1024 * 1024} onPress={() => void shoot()} style={{ alignSelf: "center", width: 76, height: 76, borderRadius: 40, backgroundColor: capturing ? "#bbb" : "white", borderWidth: 6, borderColor: "#a9bc9d", alignItems: "center", justifyContent: "center" }}><Text style={{ fontSize: 28, color: "#35452e" }}>●</Text></Pressable>
            <Text style={{ color: "#eee", textAlign: "center", fontSize: 12 }}>3200万画素以下の最大サイズで撮影します。写真は圧縮しません。</Text>
          </View>
          {showQueue && <View style={{ position: "absolute", top: 70, bottom: 190, left: 12, right: 12, backgroundColor: "#f8f8f3", borderRadius: 12, padding: 12 }}>
            <ScrollView>{items.slice().reverse().map((item) => <View key={item.id} style={{ flexDirection: "row", alignItems: "center", paddingVertical: 9, borderBottomWidth: 1, borderColor: "#ddd", gap: 10 }}>
              <Image source={{ uri: item.uri }} style={{ width: 42, height: 42, borderRadius: 4 }} /><View style={{ flex: 1 }}><Text numberOfLines={1}>{item.filename} · {item.status}</Text>{item.lastError && <Text style={{ color: "#a33", fontSize: 12 }}>{item.lastError}</Text>}</View>
              {item.status === "失敗" && <Pressable onPress={() => void queue.retry(item.id)}><Text style={{ color: "#42683a" }}>再試行</Text></Pressable>}
              {item.status !== "送信中" && <Pressable onPress={() => void queue.discard(item.id)}><Text style={{ color: "#a33", paddingLeft: 8 }}>破棄</Text></Pressable>}
            </View>)}</ScrollView>
          </View>}
          {!cameraReady && <View style={{ position: "absolute", top: "48%", alignSelf: "center" }}><ActivityIndicator color="white" /><Text style={{ color: "white" }}>カメラを準備中…</Text></View>}
        </>}
      </View>}
    </SafeAreaView>
  </Modal>;
}
