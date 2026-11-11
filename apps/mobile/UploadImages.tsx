import React, { useEffect, useRef, useState } from "react";
import {
  Alert,
  Image,
  Linking,
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
        selectionLimit: 10,
        quality: 1,
        preferredAssetRepresentationMode:
          ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
      if (!result.canceled) {
        setAssets(result.assets);
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
    <View style={{ paddingVertical: 20, gap: 14 }}>
      <Text style={{ color: "#435238" }}>
        保存先：
        {!status
          ? "確認中…"
          : status.destination === "drive"
            ? "自分のGoogle Drive / Folio uploads"
            : "Folio Cloud Storage（非公開）"}
      </Text>
      {status?.reauthRequired && (
        <>
          <Text>
            Webの「作品を追加」からDriveのアップロード権限を追加して、再度この画面を開いてください。
          </Text>
          <Pressable onPress={() => Linking.openURL(api)}>
            <Text style={{ color: "#527145" }}>Webで権限を追加 →</Text>
          </Pressable>
        </>
      )}
      <Pressable
        disabled={busy || !status?.canUpload}
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
          ＋ 写真から選択（最大10枚・1枚20MB）
        </Text>
      </Pressable>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {assets.map((asset, i) => (
          <Image
            key={asset.uri + i}
            source={{ uri: asset.uri }}
            style={{ width: 60, height: 60, borderRadius: 6 }}
          />
        ))}
      </View>
      <Text>保存するグループ</Text>
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
      <Text style={{ color: "#718364", fontSize: 11 }}>
        共有グループに保存すると、そのグループのメンバーにも表示されます。
      </Text>
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
          {busy ? "アップロード中…" : `${assets.length}枚をアップロード`}
        </Text>
      </Pressable>
      {!!message && <Text accessibilityRole="alert">{message}</Text>}
      <Text style={{ marginTop: 16, color: "#718364" }}>
        または画像URLから追加
      </Text>
    </View>
  );
}
