import React from "react";
import {
  SafeAreaView,
  ScrollView,
  Text,
  Pressable,
  StyleSheet,
} from "react-native";

export default function Onboarding({
  busy,
  onDismiss,
}: {
  busy: boolean;
  onDismiss: (settings: boolean) => void;
}) {
  return (
    <SafeAreaView style={s.safe}>
      <ScrollView contentContainerStyle={s.content}>
        <Text style={s.brand}>folio ✳</Text>
        <Text style={s.title}>画像と作品を、あなたのライブラリに。</Text>
        <Text style={s.text}>
          Folioは、デザイナーやイラストレーターなど、参考画像や制作物を集める方のためのアプリです。画像・作品をグループやコレクションで整理できます。
        </Text>
        <Text style={s.heading}>まずはサンプルで試す</Text>
        <Text style={s.text}>
          初回はログインせずに、Unsplashの画像を使ったサンプル作品を閲覧できます。デモでの変更はこの端末だけに保存され、同期されません。
        </Text>
        <Text style={s.heading}>自分だけのクラウドライブラリ</Text>
        <Text style={s.text}>
          「設定」を開き、AppleまたはGoogleでログインしてください。ログイン後のアップロードは、Google
          Drive未接続なら非公開のCloud
          Storageへ、接続した場合は自分のDriveへ保存されます。Drive接続は任意です。
        </Text>
        <Text style={s.heading}>グループで共有する</Text>
        <Text style={s.text}>
          ログイン後、グループのオーナーはFolioユーザーをメールアドレスで追加し、作品を共有できます。受け取った側は共有作品を通報したり、そのユーザーをブロックしたりできます。
        </Text>
        <Text style={s.heading}>アカウントと料金</Text>
        <Text style={s.text}>
          アカウントは「設定」から削除できます。Folioのライブラリデータ、グループへの参加情報、セッション、管理するCloud
          Storageファイルが削除されます。Google
          Driveの元ファイルは残ります。アプリ内の購入・定期購読・支払いはありません。
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          style={s.primary}
          onPress={() => onDismiss(false)}
        >
          <Text style={s.primaryText}>はじめる</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          style={s.secondary}
          onPress={() => onDismiss(true)}
        >
          <Text style={s.secondaryText}>設定を開く</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#fafbf8" },
  content: { padding: 26, gap: 12, paddingBottom: 36 },
  brand: { color: "#637659", fontSize: 32, fontWeight: "800" },
  title: {
    color: "#303c2b",
    fontSize: 25,
    fontWeight: "600",
    marginVertical: 8,
  },
  heading: { color: "#303c2b", fontSize: 17, fontWeight: "600", marginTop: 8 },
  text: { color: "#57634f", fontSize: 14, lineHeight: 23 },
  primary: {
    backgroundColor: "#526945",
    borderRadius: 8,
    padding: 16,
    marginTop: 10,
  },
  primaryText: { color: "#fff", textAlign: "center", fontWeight: "600" },
  secondary: {
    borderWidth: 1,
    borderColor: "#d4deca",
    borderRadius: 8,
    padding: 16,
  },
  secondaryText: { color: "#526945", textAlign: "center", fontWeight: "600" },
});
