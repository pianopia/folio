import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Modal,
  SafeAreaView,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import type { Artwork, Group } from "@folio/shared";
export default function UploadImages({
  api,
  token,
  groups,
  onUploaded,
}: {
  api: string;
  token: string;
  groups: Group[];
  onUploaded: (art: Artwork) => void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [assets, setAssets] = useState<ImagePicker.ImagePickerAsset[]>([]),
    [groupId, setGroupId] = useState(groups[0]?.id ?? ""),
    [collection, setCollection] = useState("Uploads"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const preview = previewIndex === null ? undefined : assets[previewIndex];
  function removeAsset(index: number) {
    if (busy) return;
    const remaining = assets.filter((_, i) => i !== index);
    setAssets(remaining);
    if (previewIndex !== null)
      setPreviewIndex(
        remaining.length ? Math.min(previewIndex, remaining.length - 1) : null,
      );
  }
  const [status, setStatus] = useState<{
    destination: string;
    canUpload: boolean;
    reauthRequired: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    fetch(`${api}/api/uploads/status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => {
        if (active) setMessage("保存先を確認できませんでした");
      });
    return () => {
      active = false;
    };
  }, [api, token]);
  async function select() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, 10 - assets.length),
        quality: 1,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (!result.canceled) {
        const selected = [...assets];
        for (const asset of result.assets)
          if (
            !selected.some(
              (existing) =>
                (asset.assetId && existing.assetId === asset.assetId) ||
                existing.uri === asset.uri,
            )
          )
            selected.push(asset);
        if (selected.length > 10) {
          setMessage("画像は合計10枚までです。不要な画像を外してください");
          return;
        }
        setPreviewIndex(null);
        setAssets(selected);
        setMessage("");
      }
    } catch {
      Alert.alert(
        "写真を選択できませんでした",
        "写真へのアクセスを確認してください。",
      );
    }
  }
  async function upload() {
    setPreviewIndex(null);
    setBusy(true);
    const failed: ImagePicker.ImagePickerAsset[] = [];
    let count = 0;
    try {
      for (const asset of assets) {
        try {
          if (asset.fileSize && asset.fileSize > 20 * 1024 * 1024)
            throw Error("画像は1枚20MB以下にしてください");
          setMessage(`${++count} / ${assets.length} 枚を保存中…`);
          const form = new FormData();
          form.append("file", {
            uri: asset.uri,
            name: asset.fileName || "photo.jpg",
            type: asset.mimeType || "image/jpeg",
          } as unknown as Blob);
          form.append("groupId", groupId);
          form.append("collection", collection.trim() || "Uploads");
          const response = await fetch(`${api}/api/artworks/upload`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: form,
            signal: AbortSignal.timeout(100000),
          });
          const body = await response.json();
          if (!response.ok)
            throw Error(body.error || "アップロードできませんでした");
          if (!mounted.current) break;
          onUploaded(body);
        } catch (e) {
          failed.push(asset);
          Alert.alert(
            asset.fileName || "アップロード失敗",
            (e as Error).message,
          );
        }
      }
      setAssets(failed);
      setMessage(
        failed.length
          ? `${failed.length}枚を再試行できます`
          : "画像を保存しました",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ paddingVertical: 12, gap: 12 }}>
      <Text style={{ color: "#435238" }}>
        {!status
          ? "確認中…"
          : status.destination === "drive"
            ? "Google Drive"
            : "Folio（非公開）"}
      </Text>
      {status?.reauthRequired && (
        <>
          <Text>Driveのアップロード権限が必要です。</Text>
          <Pressable onPress={() => Linking.openURL(api)}>
            <Text style={{ color: "#527145" }}>Webで権限を追加 →</Text>
          </Pressable>
        </>
      )}
      <Pressable
        disabled={busy || !status?.canUpload || assets.length >= 10}
        onPress={select}
        style={{
          padding: 20,
          borderWidth: 1,
          borderStyle: "dashed",
          borderColor: "#9baf89",
          borderRadius: 10,
        }}
      >
        <Text style={{ color: "#435238", textAlign: "center" }}>
          {assets.length ? "＋ 写真を追加" : "＋ 写真を選択"}
        </Text>
      </Pressable>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {assets.map((asset, i) => (
          <View key={asset.uri}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${asset.fileName || `写真${i + 1}`}を大きくプレビュー`}
              disabled={busy}
              onPress={() => setPreviewIndex(i)}
            >
              <Image
                source={{ uri: asset.uri }}
                style={{ width: 84, height: 84, borderRadius: 6 }}
              />
            </Pressable>
            <Pressable
              accessibilityLabel={`写真${i + 1}を選択から外す`}
              disabled={busy}
              onPress={() => removeAsset(i)}
              style={{
                position: "absolute",
                top: 3,
                right: 3,
                width: 24,
                height: 24,
                borderRadius: 12,
                backgroundColor: "#0009",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ color: "#fff", fontSize: 18 }}>×</Text>
            </Pressable>
          </View>
        ))}
      </View>
      <Modal
        visible={!!preview}
        transparent
        animationType="fade"
        onRequestClose={() => setPreviewIndex(null)}
      >
        <SafeAreaView
          style={{ flex: 1, backgroundColor: "#182214fa", padding: 20 }}
        >
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              gap: 16,
              alignItems: "center",
              paddingVertical: 18,
            }}
          >
            <Text style={{ color: "#fff", flex: 1 }} numberOfLines={2}>
              {(previewIndex ?? 0) + 1} / {assets.length}
              {"\n"}
              {preview?.fileName || "写真"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="プレビューを閉じる"
              onPress={() => setPreviewIndex(null)}
              style={{ padding: 12 }}
            >
              <Text style={{ color: "#fff" }}>×</Text>
            </Pressable>
          </View>
          {preview && (
            <Image
              accessibilityLabel={preview.fileName || "選択した画像"}
              source={{ uri: preview.uri }}
              resizeMode="contain"
              style={{ flex: 1, width: "100%" }}
            />
          )}
          <Text style={{ textAlign: "center", color: "#cbd7bf", padding: 14 }}>
            未アップロード
          </Text>
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              paddingVertical: 18,
            }}
          >
            <Pressable
              accessibilityLabel="前の選択画像"
              disabled={assets.length < 2}
              onPress={() =>
                setPreviewIndex(
                  (i) => ((i ?? 0) - 1 + assets.length) % assets.length,
                )
              }
              style={{ padding: 14 }}
            >
              <Text style={{ color: "#fff" }}>←</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="表示中の画像を選択から外す"
              onPress={() => removeAsset(previewIndex ?? 0)}
              style={{ padding: 14 }}
            >
              <Text style={{ color: "#e5bfa5" }}>選択から外す</Text>
            </Pressable>
            <Pressable
              accessibilityLabel="次の選択画像"
              disabled={assets.length < 2}
              onPress={() =>
                setPreviewIndex((i) => ((i ?? 0) + 1) % assets.length)
              }
              style={{ padding: 14 }}
            >
              <Text style={{ color: "#fff" }}>→</Text>
            </Pressable>
          </View>
        </SafeAreaView>
      </Modal>
      <Text>グループ</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {groups.map((g) => (
          <Pressable
            key={g.id}
            disabled={busy}
            onPress={() => setGroupId(g.id)}
            style={{
              padding: 9,
              borderRadius: 6,
              backgroundColor: groupId === g.id ? "#dfe9d5" : "#f3f5f0",
            }}
          >
            <Text>{g.name}</Text>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: optionsOpen }}
        onPress={() => setOptionsOpen(!optionsOpen)}
      >
        <Text style={{ color: "#718364", fontSize: 11 }}>
          詳細設定 {optionsOpen ? "−" : "＋"}
        </Text>
      </Pressable>
      {optionsOpen && (
        <TextInput
          accessibilityLabel="アップロードのコレクション"
          value={collection}
          maxLength={120}
          editable={!busy}
          onChangeText={setCollection}
          style={{
            borderWidth: 1,
            borderColor: "#dce5d2",
            borderRadius: 6,
            padding: 12,
          }}
        />
      )}
      <Pressable
        disabled={busy || !assets.length || !groupId || !status?.canUpload}
        onPress={upload}
        style={{
          backgroundColor: "#3b5832",
          opacity: busy || !assets.length ? 0.5 : 1,
          borderRadius: 7,
          padding: 15,
        }}
      >
        <Text style={{ color: "white", textAlign: "center" }}>
          {busy
            ? "アップロード中…"
            : assets.length
              ? `アップロード（${assets.length}）`
              : "アップロード"}
        </Text>
      </Pressable>
      {!!message && <Text accessibilityRole="alert">{message}</Text>}
    </View>
  );
}
