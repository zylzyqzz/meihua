import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, type VRM } from '@pixiv/three-vrm';
import type { AvatarActionName, LipSyncPlan } from '@meihua/core-types';
import './VrmAvatar.css';

type Props = {
  src: string;
  action: AvatarActionName;
  lipSyncPlan?: LipSyncPlan;
  startedAt?: number;
  now?: () => number;
};

const mouthNames = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const material of materials) material.dispose();
  });
}

function activeViseme(plan: LipSyncPlan | undefined, elapsed: number): number {
  if (!plan) return 0;
  for (let index = plan.visemes.length - 1; index >= 0; index--) {
    if (plan.visemes[index]!.offsetMs <= elapsed) return Math.abs(plan.visemes[index]!.viseme) % 5;
  }
  return 0;
}

function setMouth(vrm: VRM, value: number, vowel = 0): void {
  const manager = vrm.expressionManager;
  if (!manager) return;
  mouthNames.forEach((name, index) => manager.setValue(name, index === vowel ? value : 0));
}

/** Shared 30fps transparent VRM renderer used by both editor preview and OBS. */
export function VrmAvatar({ src, action, lipSyncPlan, startedAt, now = Date.now }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef({ action, lipSyncPlan, startedAt, now });
  runtimeRef.current = { action, lipSyncPlan, startedAt, now };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let frame = 0;
    let vrm: VRM | undefined;
    let lastRender = 0;
    let mouth = 0;
    const clock = new THREE.Clock();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
    camera.position.set(0, 1.3, 2.55);
    camera.lookAt(0, 1.25, 0);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xfff4df, 0x202b3d, 2.2));
    const key = new THREE.DirectionalLight(0xffd8a8, 2.6);
    key.position.set(1.4, 2.8, 2.2);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x62bddd, 1.4);
    rim.position.set(-2, 1.8, -1.5);
    scene.add(rim);

    const resize = () => {
      const width = Math.max(1, host.clientWidth);
      const height = Math.max(1, host.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(src, (gltf) => {
      if (disposed) return;
      vrm = gltf.userData.vrm as VRM | undefined;
      if (!vrm) return;
      vrm.scene.position.set(0, 0, 0);
      scene.add(vrm.scene);
    }, undefined, () => host.setAttribute('data-vrm-error', 'true'));

    const animate = (time: number) => {
      frame = requestAnimationFrame(animate);
      if (time - lastRender < 1000 / 30) return;
      const delta = Math.min(clock.getDelta(), 0.05);
      lastRender = time;
      if (vrm) {
        const state = runtimeRef.current;
        const elapsed = state.startedAt ? Math.max(0, state.now() - state.startedAt) : -1;
        const index = elapsed >= 0 && state.lipSyncPlan ? Math.floor(elapsed / state.lipSyncPlan.frameIntervalMs) : -1;
        const target = state.action.startsWith('SPEAKING') && index >= 0
          ? state.lipSyncPlan?.amplitudes[index]?.mouthOpen ?? 0
          : 0;
        mouth += (target - mouth) * Math.min(1, delta * 18);
        const vowel = index >= 0 ? activeViseme(state.lipSyncPlan, elapsed) : 0;
        setMouth(vrm, mouth, vowel);
        const blink = Math.pow(Math.max(0, Math.sin(time / 1000 * 0.72 - 1.35)), 32);
        vrm.expressionManager?.setValue('blink', blink);
        const head = vrm.humanoid?.getNormalizedBoneNode('head');
        const chest = vrm.humanoid?.getNormalizedBoneNode('chest');
        if (head) {
          const emphasis = state.action === 'SPEAKING_EMPHASIS' ? 0.055 : 0.025;
          head.rotation.y = Math.sin(time / 1300) * emphasis;
          head.rotation.x = state.action === 'THINKING' ? 0.07 : Math.sin(time / 1800) * 0.012;
        }
        if (chest) chest.rotation.z = Math.sin(time / 1650) * 0.012;
        vrm.update(delta);
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(animate);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (vrm) {
        scene.remove(vrm.scene);
        disposeObject(vrm.scene);
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src]);

  return <div ref={hostRef} className="vrm-avatar" aria-label="透明 VRM 数字人" />;
}
