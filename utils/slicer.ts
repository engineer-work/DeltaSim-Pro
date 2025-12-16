import { Position, SlicerSettings, GCodeFile, ModelTransform } from '../types';

interface Triangle {
  p1: Position;
  p2: Position;
  p3: Position;
  normal: Position;
}

interface Segment {
  start: Position;
  end: Position;
}

// --- STL PARSER ---
export const parseSTL = (buffer: ArrayBuffer): Triangle[] => {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const triangles: Triangle[] = [];
  let offset = 84;

  // Browser safety limit
  const limit = Math.min(triangleCount, 25000); 

  for (let i = 0; i < limit; i++) {
    const normal = {
      x: view.getFloat32(offset, true),
      y: view.getFloat32(offset + 4, true),
      z: view.getFloat32(offset + 8, true),
    };
    const p1 = {
      x: view.getFloat32(offset + 12, true),
      y: view.getFloat32(offset + 16, true),
      z: view.getFloat32(offset + 20, true),
    };
    const p2 = {
      x: view.getFloat32(offset + 24, true),
      y: view.getFloat32(offset + 28, true),
      z: view.getFloat32(offset + 32, true),
    };
    const p3 = {
      x: view.getFloat32(offset + 36, true),
      y: view.getFloat32(offset + 40, true),
      z: view.getFloat32(offset + 44, true),
    };
    triangles.push({ p1, p2, p3, normal });
    offset += 50;
  }
  return triangles;
};

// --- GEOMETRY UTILS ---
const applyTransform = (tri: Triangle, t: ModelTransform): Triangle => {
  const transformPoint = (p: Position) => ({
    x: p.x * t.scale + t.x,
    y: p.y * t.scale + t.y,
    z: p.z * t.scale + t.z,
  });
  return {
    p1: transformPoint(tri.p1),
    p2: transformPoint(tri.p2),
    p3: transformPoint(tri.p3),
    normal: tri.normal,
  };
};

const getZBounds = (triangles: Triangle[]) => {
  let min = Infinity;
  let max = -Infinity;
  triangles.forEach(t => {
    min = Math.min(min, t.p1.z, t.p2.z, t.p3.z);
    max = Math.max(max, t.p1.z, t.p2.z, t.p3.z);
  });
  return { min, max };
};

const intersectTriangleZ = (tri: Triangle, z: number): Segment | null => {
  const points = [tri.p1, tri.p2, tri.p3];
  const above: Position[] = [];
  const below: Position[] = [];

  // Classify points relative to Z plane
  points.forEach(p => {
    if (p.z >= z) above.push(p);
    else below.push(p);
  });

  // No intersection if all points are on same side
  if (above.length === 3 || below.length === 3) return null;

  const intersectEdge = (p1: Position, p2: Position) => {
    const t = (z - p1.z) / (p2.z - p1.z);
    return {
      x: p1.x + t * (p2.x - p1.x),
      y: p1.y + t * (p2.y - p1.y),
      z: z
    };
  };

  if (above.length === 1 && below.length === 2) {
    // 1 point above, 2 below -> intersects 2 edges connected to the top point
    return {
      start: intersectEdge(above[0], below[0]),
      end: intersectEdge(above[0], below[1])
    };
  } else if (above.length === 2 && below.length === 1) {
    // 2 points above, 1 below -> intersects 2 edges connected to the bottom point
    return {
      start: intersectEdge(below[0], above[0]),
      end: intersectEdge(below[0], above[1])
    };
  }

  return null;
};

// --- TOPOLOGY RECONSTRUCTION (Fixing the "Red Mess") ---
// Stitches loose segments into closed loops (polygons)
const chainSegments = (segments: Segment[]): Position[][] => {
  const loops: Position[][] = [];
  const pool = [...segments];
  const EPSILON = 0.05; // mm tolerance for connecting points

  while (pool.length > 0) {
    // Start a new loop with the last segment in the pool
    const firstSeg = pool.pop()!;
    const loop: Position[] = [firstSeg.start, firstSeg.end];
    
    let growing = true;
    while (growing) {
      growing = false;
      const tail = loop[loop.length - 1];
      
      // Find a segment that starts near our tail
      // Reverse check is needed because STL normals aren't always perfect in raw segment soup
      const nextIdx = pool.findIndex(seg => 
        Math.hypot(seg.start.x - tail.x, seg.start.y - tail.y) < EPSILON ||
        Math.hypot(seg.end.x - tail.x, seg.end.y - tail.y) < EPSILON
      );

      if (nextIdx !== -1) {
        const nextSeg = pool.splice(nextIdx, 1)[0];
        // Determine orientation
        const matchStart = Math.hypot(nextSeg.start.x - tail.x, nextSeg.start.y - tail.y) < EPSILON;
        
        if (matchStart) {
          loop.push(nextSeg.end);
        } else {
          loop.push(nextSeg.start);
        }
        growing = true;
      }
    }
    
    // Check if loop is closed (approx)
    const head = loop[0];
    const tail = loop[loop.length - 1];
    if (Math.hypot(head.x - tail.x, head.y - tail.y) < EPSILON * 2) {
       // Close the loop perfectly
       loop[loop.length - 1] = head;
    }
    
    if (loop.length > 2) {
      loops.push(loop);
    }
  }

  return loops;
};

// --- SLICER ENGINE ---
export const sliceMesh = (
  rawTriangles: Triangle[], 
  transform: ModelTransform,
  settings: SlicerSettings
): { paths: Position[], gcode: GCodeFile } => {
  
  // 1. Transform geometry
  const triangles = rawTriangles.map(t => applyTransform(t, transform));
  
  // 2. Determine bounds
  const { min: minZ, max: maxZ } = getZBounds(triangles);
  
  // 3. Slice layer by layer
  // Group segments by layer
  const layers: Position[][][] = []; // Layer -> Loops -> Points
  
  // Filament Math
  const filamentArea = Math.PI * Math.pow(settings.filamentDiameter / 2, 2);
  const extrusionPerMM = (settings.nozzleDiameter * settings.layerHeight) / filamentArea;

  for (let z = minZ + 0.2; z <= maxZ; z += settings.layerHeight) {
    const layerSegments: Segment[] = [];
    
    // Find intersections
    for (const tri of triangles) {
      // Optimization: Z-check
      const tMin = Math.min(tri.p1.z, tri.p2.z, tri.p3.z);
      const tMax = Math.max(tri.p1.z, tri.p2.z, tri.p3.z);
      if (z < tMin || z > tMax) continue;

      const seg = intersectTriangleZ(tri, z);
      if (seg) layerSegments.push(seg);
    }

    // Topology: Connect segments into contours
    if (layerSegments.length > 0) {
      const contours = chainSegments(layerSegments);
      layers.push(contours);
    } else {
      layers.push([]);
    }
  }

  // 4. Generate G-code
  const gcodeLines: string[] = [];
  const visualPath: Position[] = [];
  
  gcodeLines.push(`; Generated by DeltaSim Pro Slicer`);
  gcodeLines.push(`M104 S${settings.temperature} ; Set Temp`);
  gcodeLines.push(`G28 ; Home all axes`);
  gcodeLines.push(`M109 S${settings.temperature} ; Wait for Temp`);
  gcodeLines.push(`G90 ; Absolute positioning`);
  gcodeLines.push(`G92 E0 ; Reset Extruder`);

  let totalFilament = 0;
  let totalTime = 0;
  let currentPos = { x: 0, y: 0, z: 0 }; 

  layers.forEach((loops, index) => {
    const layerZ = minZ + 0.2 + (index * settings.layerHeight);
    if (loops.length === 0) return;

    gcodeLines.push(`; --- Layer ${index + 1} Z=${layerZ.toFixed(2)} ---`);
    gcodeLines.push(`G1 Z${layerZ.toFixed(3)} F${settings.travelSpeed}`);
    totalTime += (Math.abs(layerZ - currentPos.z) / settings.travelSpeed) * 60;
    currentPos.z = layerZ;

    // Process each loop (contour) in this layer
    loops.forEach(loop => {
      if (loop.length < 2) return;

      // 1. Move to start of loop (Travel)
      const start = loop[0];
      const travelDist = Math.hypot(start.x - currentPos.x, start.y - currentPos.y);
      if (travelDist > 0.05) {
        gcodeLines.push(`G0 X${start.x.toFixed(3)} Y${start.y.toFixed(3)} F${settings.travelSpeed}`);
        // Flag z=-999 or similar in visualPath to indicate "Travel" (pen up) if needed, 
        // but typically we just draw a line. We'll mark travel in visualization by comparing G0 vs G1 logic.
        // For visualizer simplicity, we add points. 
        // To make visualizer understand "travel", we might duplicate the point or use specific coloring logic.
        // Here we just push the point.
        visualPath.push({ x: start.x, y: start.y, z: layerZ }); 
        
        totalTime += (travelDist / settings.travelSpeed) * 60;
        currentPos = { ...start, z: layerZ };
      }

      // 2. Extrude through loop
      for (let i = 1; i < loop.length; i++) {
        const p = loop[i];
        const dist = Math.hypot(p.x - currentPos.x, p.y - currentPos.y);
        const extrudeAmount = dist * extrusionPerMM;
        totalFilament += extrudeAmount;
        
        gcodeLines.push(`G1 X${p.x.toFixed(3)} Y${p.y.toFixed(3)} E${totalFilament.toFixed(5)} F${settings.printSpeed}`);
        visualPath.push({ x: p.x, y: p.y, z: layerZ });
        
        totalTime += (dist / settings.printSpeed) * 60;
        currentPos = { ...p, z: layerZ };
      }
    });
  });

  gcodeLines.push(`M104 S0 ; Turn off heater`);
  gcodeLines.push(`G28 ; Home`);
  gcodeLines.push(`M84 ; Disable motors`);

  return {
    paths: visualPath,
    gcode: {
      name: 'output.gcode',
      lines: gcodeLines,
      totalTime,
      totalFilament
    }
  };
};