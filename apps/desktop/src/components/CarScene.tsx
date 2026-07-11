import { useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { Mesh } from "three";

import type { BodyType, ModuleLocation, VehicleSystemCategory } from "@ecu/vehicle-db";

/**
 * The 3D cockpit scene — a procedural, hologram-style vehicle (layered translucent
 * panels + bright edge wireframe) whose proportions change by body type, with a
 * glowing hotspot per module. Fully self-contained geometry (no GLTF/HDRI/workers),
 * so it renders under the app's strict CSP with zero network dependencies.
 *
 * Module placement: common modules have canonical anchor points; anything without
 * one floats on a shelf ABOVE the car. A collision pass stacks any two hotspots
 * that would still overlap, so nothing ever draws on top of anything else.
 */

export interface SceneModule {
  id: string;
  label: string;
  category: VehicleSystemCategory;
  location: ModuleLocation;
  online: boolean;
}

interface Props {
  bodyType: BodyType;
  modules: SceneModule[];
  selectedId: string | null;
  running: boolean;
  onSelect: (id: string) => void;
}

type V3 = [number, number, number];

const CAT_COLOR: Record<VehicleSystemCategory, string> = {
  powertrain: "#f97316", transmission: "#eab308", chassis: "#38bdf8", body: "#a78bfa",
  safety: "#ef4444", infotainment: "#22d3ee", hvac: "#34d399", network: "#94a3b8", other: "#94a3b8",
};

// Canonical anchor points for common modules (kept > 0.42 apart so they never overlap).
const ANCHOR: Record<string, V3> = {
  ecm: [1.55, 0.80, 0.32], pcm: [1.55, 0.80, 0.32], engine: [1.55, 0.80, 0.32],
  tcm: [1.35, 0.56, -0.38], tcu: [1.35, 0.56, -0.38],
  abs: [0.15, 0.44, 0.55], vsc: [0.15, 0.44, 0.55],
  srs: [0.35, 0.74, 0.00], airbag: [0.35, 0.74, 0.00],
  bcm: [0.72, 1.00, -0.46], body: [0.72, 1.00, -0.46],
  meter: [0.82, 1.08, 0.02], ic: [0.82, 1.08, 0.02], cluster: [0.82, 1.08, 0.02],
  hvac: [0.58, 0.72, 0.52], ac: [0.58, 0.72, 0.52],
  fcm: [1.98, 0.56, 0.00], radar: [1.98, 0.56, 0.00],
  eps: [1.05, 0.58, 0.55], steering: [1.05, 0.58, 0.55],
  gateway: [0.55, 0.96, 0.30], immo: [0.50, 0.94, -0.28], cert: [0.35, 0.94, -0.30], smartkey: [0.35, 0.94, -0.30],
  epb: [-1.45, 0.44, 0.10], park: [-1.98, 0.56, 0.00], tpms: [-1.30, 0.44, 0.55],
  radio: [0.50, 0.86, 0.02], hud: [0.88, 1.18, 0.00],
};

const CAT_ANCHOR: Partial<Record<VehicleSystemCategory, V3>> = {
  powertrain: [1.55, 0.80, 0.32], transmission: [1.35, 0.56, -0.38], chassis: [0.15, 0.44, 0.55],
  safety: [0.35, 0.74, 0.00], body: [0.72, 1.00, -0.46], infotainment: [0.82, 1.08, 0.02],
  hvac: [0.58, 0.72, 0.52], network: [0.55, 0.96, 0.30],
};

const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function placeModules(mods: SceneModule[]): Map<string, V3> {
  const placed: { id: string; p: V3 }[] = [];
  const MIN = 0.42;
  let shelf = 0;
  for (const m of mods) {
    const id = m.id.toLowerCase();
    let base: V3 | undefined = ANCHOR[id] ?? (m.category !== "other" ? CAT_ANCHOR[m.category] : undefined);
    if (!base) {
      // floating shelf above the car — grid, guaranteed off the body
      const col = shelf % 4;
      const row = Math.floor(shelf / 4);
      base = [-1.6 + col * 1.05, 2.5 + row * 0.55, -0.7 + (shelf % 2) * 1.4];
      shelf++;
    }
    let p: V3 = [base[0], base[1], base[2]];
    let guard = 0;
    while (placed.some((q) => dist(q.p, p) < MIN) && guard < 50) {
      p = [p[0], p[1] + 0.3, p[2]];
      guard++;
    }
    placed.push({ id: m.id, p });
  }
  return new Map(placed.map((x) => [x.id, x.p]));
}

// Cabin/greenhouse params per body type: [lengthX, heightY, centerX, topY].
const CABIN: Record<BodyType, [number, number, number, number]> = {
  sedan:     [1.85, 0.52, 0.02, 1.12],
  coupe:     [1.55, 0.46, 0.12, 1.02],
  hatchback: [1.70, 0.56, -0.05, 1.12],
  wagon:     [2.35, 0.58, -0.22, 1.14],
  suv:       [2.45, 0.74, -0.10, 1.26],
  minivan:   [2.95, 0.92, -0.10, 1.36],
  van:       [3.05, 1.02, 0.00, 1.42],
  truck:     [1.30, 0.60, 0.78, 1.18],
};

function Panel({ size, position, rotation, edge = "#38bdf8", fill = "#0b2536", fillO = 0.16, edgeO = 0.5 }:
  { size: V3; position: V3; rotation?: V3; edge?: string; fill?: string; fillO?: number; edgeO?: number }) {
  return (
    <group position={position} rotation={rotation}>
      <mesh><boxGeometry args={size} /><meshStandardMaterial color={fill} transparent opacity={fillO} /></mesh>
      <mesh scale={1.004}><boxGeometry args={size} /><meshStandardMaterial color={edge} wireframe transparent opacity={edgeO} /></mesh>
    </group>
  );
}

function Wheel({ position }: { position: V3 }) {
  return (
    <group position={position} rotation={[Math.PI / 2, 0, 0]}>
      <mesh><cylinderGeometry args={[0.42, 0.42, 0.26, 26]} /><meshStandardMaterial color="#0e1726" /></mesh>
      <mesh scale={1.004}><cylinderGeometry args={[0.42, 0.42, 0.26, 26]} /><meshStandardMaterial color="#3b4a63" wireframe transparent opacity={0.6} /></mesh>
      <mesh position={[0, 0.145, 0]}><cylinderGeometry args={[0.23, 0.23, 0.05, 16]} /><meshStandardMaterial color="#7c8aa3" metalness={0.6} roughness={0.4} /></mesh>
    </group>
  );
}

function CarBody({ bodyType }: { bodyType: BodyType }) {
  const [clen, ch, cx, ctop] = CABIN[bodyType];
  const cy = ctop - ch / 2;
  const wsX = cx + clen / 2 + 0.12;   // windshield seam
  const rwX = cx - clen / 2 - 0.12;   // rear-glass seam
  return (
    <group>
      {/* lower body / sills */}
      <Panel size={[3.7, 0.42, 1.72]} position={[0, 0.46, 0]} />
      {/* door line / beltline */}
      <Panel size={[3.4, 0.34, 1.74]} position={[-0.05, 0.82, 0]} fillO={0.12} />
      {/* hood + front deck */}
      <Panel size={[1.05, 0.16, 1.62]} position={[1.42, 0.95, 0]} fillO={0.2} />
      {/* rear deck */}
      <Panel size={[0.9, 0.16, 1.62]} position={[-1.5, 0.95, 0]} fillO={0.2} />
      {/* nose + tail fascia */}
      <Panel size={[0.22, 0.46, 1.72]} position={[1.98, 0.6, 0]} fillO={0.24} />
      <Panel size={[0.22, 0.46, 1.72]} position={[-1.98, 0.6, 0]} fillO={0.24} />
      {/* greenhouse + roof */}
      <Panel size={[clen, ch, 1.52]} position={[cx, cy, 0]} fillO={0.1} edgeO={0.6} />
      <Panel size={[clen * 0.92, 0.06, 1.5]} position={[cx, ctop, 0]} fillO={0.28} />
      {/* windshield + rear glass (angled) */}
      <Panel size={[0.5, 0.03, 1.46]} position={[wsX, (0.98 + ctop) / 2, 0]} rotation={[0, 0, Math.PI * 0.2]} edge="#7dd3fc" fill="#0e3a52" fillO={0.22} />
      <Panel size={[0.46, 0.03, 1.46]} position={[rwX, (0.98 + ctop) / 2, 0]} rotation={[0, 0, -Math.PI * 0.22]} edge="#7dd3fc" fill="#0e3a52" fillO={0.22} />
      {/* wheels */}
      <Wheel position={[1.35, 0.42, -0.98]} />
      <Wheel position={[1.35, 0.42, 0.98]} />
      <Wheel position={[-1.35, 0.42, -0.98]} />
      <Wheel position={[-1.35, 0.42, 0.98]} />
      {/* head / tail lights */}
      {[-0.62, 0.62].map((z) => (
        <mesh key={`h${z}`} position={[1.98, 0.74, z]}>
          <boxGeometry args={[0.06, 0.13, 0.32]} />
          <meshStandardMaterial color="#e0f2fe" emissive="#bae6fd" emissiveIntensity={1.4} toneMapped={false} />
        </mesh>
      ))}
      {[-0.62, 0.62].map((z) => (
        <mesh key={`t${z}`} position={[-1.98, 0.74, z]}>
          <boxGeometry args={[0.06, 0.13, 0.32]} />
          <meshStandardMaterial color="#fecaca" emissive="#ef4444" emissiveIntensity={1.2} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function Hotspot({
  module, pos, selected, running, onSelect,
}: { module: SceneModule; pos: V3; selected: boolean; running: boolean; onSelect: (id: string) => void }) {
  const ref = useRef<Mesh>(null);
  const color = CAT_COLOR[module.category];
  const phase = module.id.charCodeAt(0) + module.id.length;
  const floating = pos[1] > 1.6;

  useFrame((state) => {
    if (!ref.current) return;
    const t = state.clock.elapsedTime;
    const amp = module.online && running ? 0.35 : 0.1;
    const base = selected ? 1.7 : 1;
    ref.current.scale.setScalar(base * (1 + amp * Math.sin(t * 3 + phase)));
  });

  return (
    <group>
      {/* connector line down to the body for floating/stacked modules */}
      {floating && (
        <mesh position={[pos[0], (pos[1] + 1.2) / 2, pos[2]]}>
          <cylinderGeometry args={[0.006, 0.006, pos[1] - 1.2, 6]} />
          <meshStandardMaterial color={color} transparent opacity={0.4} toneMapped={false} />
        </mesh>
      )}
      <group position={pos}>
        <mesh ref={ref} onClick={(e) => { e.stopPropagation(); onSelect(module.id); }} onPointerOver={(e) => e.stopPropagation()}>
          <sphereGeometry args={[0.09, 16, 16]} />
          <meshStandardMaterial color={color} emissive={color} emissiveIntensity={module.online && running ? 1.7 : 0.5} toneMapped={false} />
        </mesh>
        {selected && (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[0.2, 0.012, 8, 32]} />
            <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.2} toneMapped={false} />
          </mesh>
        )}
      </group>
    </group>
  );
}

export function CarScene({ bodyType, modules, selectedId, running, onSelect }: Props) {
  const positions = useMemo(() => placeModules(modules), [modules]);
  return (
    <Canvas camera={{ position: [5.2, 3.4, 5.6], fov: 40 }} style={{ background: "radial-gradient(circle at 50% 25%, #0b1220 0%, #05080f 100%)" }}>
      <ambientLight intensity={0.65} />
      <directionalLight position={[6, 9, 5]} intensity={0.85} />
      <pointLight position={[-6, 3, -5]} intensity={0.5} color="#38bdf8" />
      <pointLight position={[6, 2, 5]} intensity={0.35} color="#f0abfc" />
      <gridHelper args={[26, 26, "#1e293b", "#0d1524"]} />
      <CarBody bodyType={bodyType} />
      {modules.map((m) => {
        const p = positions.get(m.id);
        return p ? <Hotspot key={m.id} module={m} pos={p} selected={m.id === selectedId} running={running} onSelect={onSelect} /> : null;
      })}
      <OrbitControls enablePan={false} minDistance={4} maxDistance={14} maxPolarAngle={Math.PI / 2.05} />
    </Canvas>
  );
}
