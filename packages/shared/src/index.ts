export type Group = { id: string; name: string; color: string };
export type Artwork = {
  id: string;
  title: string;
  groupId: string;
  collection: string;
  url: string;
  tags: string[];
  favorite: boolean;
  createdAt: string;
  source: "sample" | "drive";
  driveId?: string;
};
export const initialGroups: Group[] = [
  { id: "studio", name: "Design studio", color: "#9b9be8" },
  { id: "brand", name: "Brand team", color: "#e5ae78" },
  { id: "personal", name: "Personal space", color: "#88b8a3" },
];
const entries = [
  [
    "Quiet forms",
    "studio",
    "3D & Objects",
    "photo-1634017839464-5c339ebe3cb4",
    "3D,Abstract",
  ],
  [
    "Between the lines",
    "brand",
    "Brand inspiration",
    "photo-1550859492-d5da9d8e45f3",
    "Color,Gradient",
  ],
  [
    "A little slower",
    "personal",
    "Photography",
    "photo-1472396961693-142e6e269027",
    "Nature,Photography",
  ],
  [
    "Soft geometry",
    "studio",
    "3D & Objects",
    "photo-1618005182384-a83a8bd57fbe",
    "3D,Pastel",
  ],
  [
    "Sunday in Kyoto",
    "personal",
    "Photography",
    "photo-1493976040374-85c8e12f0c0e",
    "Travel,Japan",
  ],
  [
    "Chromatic study 02",
    "brand",
    "Brand inspiration",
    "photo-1550684848-fac1c5b4e853",
    "Abstract,Color",
  ],
  [
    "Less, but better",
    "studio",
    "Editorial",
    "photo-1490312278390-ab64016e0aa9",
    "Architecture,Minimal",
  ],
  [
    "After the rain",
    "personal",
    "Photography",
    "photo-1518837695005-2083093ee35b",
    "Ocean,Nature",
  ],
  [
    "Fluid thinking",
    "studio",
    "3D & Objects",
    "photo-1618005182384-a83a8bd57fbe",
    "Abstract,Texture",
  ],
  [
    "Earth / collection",
    "brand",
    "Editorial",
    "photo-1441974231531-c6227db76b6e",
    "Nature,Green",
  ],
  [
    "Golden hour",
    "personal",
    "Photography",
    "photo-1470252649378-9c29740c9fa8",
    "Light,Landscape",
  ],
  [
    "New perspectives",
    "studio",
    "Editorial",
    "photo-1487958449943-2429e8be8625",
    "Architecture,Minimal",
  ],
];
export const initialArtworks: Artwork[] = entries.map((e, i) => ({
  id: `art-${i}`,
  title: e[0],
  groupId: e[1],
  collection: e[2],
  url: `https://images.unsplash.com/${e[3]}?auto=format&fit=crop&w=1000&q=85`,
  tags: e[4].split(","),
  favorite: [0, 3, 7].includes(i),
  createdAt: new Date(Date.UTC(2026, 10, 12 - i)).toISOString(),
  source: "sample",
}));
