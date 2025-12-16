import { Position, GCodeParsed } from '../types';

export const parseGCodeFile = (content: string): GCodeParsed => {
  const lines = content.split('\n');
  const points: Position[] = [];
  
  let currentPos = { x: 0, y: 0, z: 0, e: 0 };
  let currentFeedrate = 3000; // mm/min default
  let totalTime = 0; // seconds
  let totalFilament = 0; // mm
  let isRelative = false; // G91 vs G90
  let isExtruderRelative = false; // M83

  let min = { x: Infinity, y: Infinity, z: Infinity };
  let max = { x: -Infinity, y: -Infinity, z: -Infinity };

  // Helper to update bounds
  const updateBounds = (p: Position) => {
    min.x = Math.min(min.x, p.x);
    min.y = Math.min(min.y, p.y);
    min.z = Math.min(min.z, p.z);
    max.x = Math.max(max.x, p.x);
    max.y = Math.max(max.y, p.y);
    max.z = Math.max(max.z, p.z);
  };

  for (const line of lines) {
    const trimmed = line.split(';')[0].trim().toUpperCase();
    if (trimmed.length === 0) continue;

    if (trimmed.startsWith('G90')) isRelative = false;
    if (trimmed.startsWith('G91')) isRelative = true;
    if (trimmed.startsWith('M82')) isExtruderRelative = false;
    if (trimmed.startsWith('M83')) isExtruderRelative = true;

    if (trimmed.startsWith('G0') || trimmed.startsWith('G1')) {
      const isTravel = trimmed.startsWith('G0');
      
      let nextX = currentPos.x;
      let nextY = currentPos.y;
      let nextZ = currentPos.z;
      let nextE = currentPos.e;

      // Parse params
      const parts = trimmed.split(' ');
      let hasMove = false;
      let extruding = false;

      parts.forEach(part => {
        const val = parseFloat(part.substring(1));
        if (isNaN(val)) return;

        switch (part[0]) {
          case 'X': nextX = isRelative ? currentPos.x + val : val; hasMove = true; break;
          case 'Y': nextY = isRelative ? currentPos.y + val : val; hasMove = true; break;
          case 'Z': nextZ = isRelative ? currentPos.z + val : val; hasMove = true; break;
          case 'E': 
            const eDelta = isExtruderRelative ? val : (val - currentPos.e);
            if (eDelta > 0) extruding = true;
            nextE = val; // Store absolute E for state tracking
            totalFilament += Math.max(0, eDelta);
            break;
          case 'F': currentFeedrate = val; break;
        }
      });

      if (hasMove) {
        const dist = Math.sqrt(
          (nextX - currentPos.x)**2 + 
          (nextY - currentPos.y)**2 + 
          (nextZ - currentPos.z)**2
        );
        
        if (dist > 0) {
          totalTime += (dist / currentFeedrate) * 60;
          
          const newPoint: Position = {
            x: nextX,
            y: nextY,
            z: nextZ,
            e: nextE,
            isTravel: isTravel || !extruding // G1 without E is essentially travel
          };
          
          points.push(newPoint);
          updateBounds(newPoint);
          
          currentPos = { x: nextX, y: nextY, z: nextZ, e: nextE };
        }
      }
    }
  }

  // Handle case where no moves were parsed
  if (points.length === 0) {
     min = { x: 0, y: 0, z: 0 };
     max = { x: 0, y: 0, z: 0 };
  }

  return {
    points,
    totalTime,
    totalFilament,
    boundingBox: { min, max }
  };
};