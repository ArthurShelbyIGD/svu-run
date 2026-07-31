// Single point of contact with Babylon.js.
//
// Every subsystem imports Babylon symbols FROM HERE, never directly from
// "@babylonjs/core/...". Two reasons:
//   1. Tree-shaking depends on deep import paths being exactly right. Getting
//      them right once, here, beats getting them wrong in eleven places.
//   2. If the engine is ever swapped or a symbol moves between Babylon
//      versions, there is one file to fix.
//
// Side-effect imports (shaders, scene components) also live here.

import '@babylonjs/core/Materials/standardMaterial';
import '@babylonjs/core/Materials/PBR/pbrMaterial';
// NB: shadowGeneratorSceneComponent is deliberately NOT imported — in Babylon 9
// the ShadowGenerator constructor registers it itself, and importing it here
// only produces a tree-shaking warning.
import '@babylonjs/core/Rendering/depthRendererSceneComponent';
import '@babylonjs/core/Meshes/thinInstanceMesh';
import '@babylonjs/core/Meshes/instancedMesh';
import '@babylonjs/core/Engines/Extensions/engine.rawTexture';
import '@babylonjs/core/Engines/Extensions/engine.cubeTexture';
import '@babylonjs/core/Engines/Extensions/engine.renderTarget';
import '@babylonjs/core/Engines/Extensions/engine.renderTargetCube';
import '@babylonjs/core/Misc/fileTools';

export { Engine } from '@babylonjs/core/Engines/engine';
export { Scene } from '@babylonjs/core/scene';

export { Vector2, Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector';
export { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
export { Scalar } from '@babylonjs/core/Maths/math.scalar';

export { TargetCamera } from '@babylonjs/core/Cameras/targetCamera';
export { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';

export { Mesh } from '@babylonjs/core/Meshes/mesh';
export { TransformNode } from '@babylonjs/core/Meshes/transformNode';
export { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
export { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';

export { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
export { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
export { Texture } from '@babylonjs/core/Materials/Textures/texture';
export { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
export { RawCubeTexture } from '@babylonjs/core/Materials/Textures/rawCubeTexture';
export { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';

export { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
export { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
export { PointLight } from '@babylonjs/core/Lights/pointLight';
export { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator';

export { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline';

export { Constants } from '@babylonjs/core/Engines/constants';
export { Layer } from '@babylonjs/core/Layers/layer';
