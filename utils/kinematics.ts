import { RobotSpecs, Position, MotorAngles, CalculationResult } from '../types';
import { MOTOR_OFFSET_ANGLES } from '../constants';

// --- INVERSE KINEMATICS (Tip XYZ -> Angles) ---
export const calculateInverseKinematics = (
  specs: RobotSpecs,
  tipPos: Position
): MotorAngles => {
  const { baseRadius, effectorRadius, bicepLength, forearmLength, nozzleLength } = specs;
  
  // Convert Tip Position to Wrist Position for IK calculation
  // The wrist is 'nozzleLength' ABOVE the tip in standard orientation
  const wristZ = tipPos.z + nozzleLength;

  let isValid = true;
  const angles: number[] = [];
  
  for (const motorAngleDeg of MOTOR_OFFSET_ANGLES) {
    const phi = (motorAngleDeg * Math.PI) / 180;
    
    // Outward frame calculations (using Wrist Z)
    const p_radial_global = tipPos.x * Math.cos(phi) + tipPos.y * Math.sin(phi);
    const y_p = -tipPos.x * Math.sin(phi) + tipPos.y * Math.cos(phi);
    const z_p = wristZ; // Use Wrist Height

    const valUnderRoot = forearmLength**2 - y_p**2;
    
    if (valUnderRoot < 0) {
      isValid = false;
      angles.push(0);
      continue;
    }
    
    const effectiveForearm = Math.sqrt(valUnderRoot);
    const X_target = (p_radial_global + effectorRadius) - baseRadius;
    const Z_target = z_p; 
    
    const R_sq = X_target**2 + Z_target**2;
    const R = Math.sqrt(R_sq);
    
    const K = (R_sq + bicepLength**2 - effectiveForearm**2) / (2 * bicepLength * R);
    
    if (Math.abs(K) > 1) {
      isValid = false;
      angles.push(0);
      continue;
    }
    
    const alpha = Math.atan2(Z_target, X_target);
    const gamma = Math.acos(K);
    const thetaRad = alpha + gamma;
    const thetaDeg = (thetaRad * 180) / Math.PI;
    angles.push(thetaDeg);
  }

  return {
    theta1: angles[0] || 0,
    theta2: angles[1] || 0,
    theta3: angles[2] || 0,
    isValid
  };
};

// --- FORWARD KINEMATICS (Angles -> Tip XYZ) ---
export const calculateForwardKinematics = (specs: RobotSpecs, angles: [number, number, number]): Position | null => {
  const { baseRadius, effectorRadius, bicepLength, forearmLength, nozzleLength } = specs;
  
  const elbows = MOTOR_OFFSET_ANGLES.map((motorAngleDeg, i) => {
    const phi = (motorAngleDeg * Math.PI) / 180;
    const theta = (angles[i] * Math.PI) / 180;

    const mx = baseRadius * Math.cos(phi);
    const my = baseRadius * Math.sin(phi);
    const mz = 0;

    const localX = bicepLength * Math.cos(theta);
    const localZ = bicepLength * Math.sin(theta);
    
    const ex = mx + localX * Math.cos(phi);
    const ey = my + localX * Math.sin(phi);
    const ez = mz + localZ;

    return { x: ex, y: ey, z: ez };
  });

  const centers = elbows.map((elb, i) => {
    const phi = (MOTOR_OFFSET_ANGLES[i] * Math.PI) / 180;
    return {
      x: elb.x - effectorRadius * Math.cos(phi),
      y: elb.y - effectorRadius * Math.sin(phi),
      z: elb.z
    };
  });

  // Tri-lateration to find Wrist Position
  const p1 = centers[0];
  const p2 = centers[1];
  const p3 = centers[2];
  const r = forearmLength;

  const v21 = { x: p2.x - p1.x, y: p2.y - p1.y, z: p2.z - p1.z };
  const d21 = Math.sqrt(v21.x**2 + v21.y**2 + v21.z**2);
  const ex = { x: v21.x/d21, y: v21.y/d21, z: v21.z/d21 };

  const v31 = { x: p3.x - p1.x, y: p3.y - p1.y, z: p3.z - p1.z };
  const i = ex.x*v31.x + ex.y*v31.y + ex.z*v31.z;
  
  const temp = { x: v31.x - i*ex.x, y: v31.y - i*ex.y, z: v31.z - i*ex.z };
  const dTemp = Math.sqrt(temp.x**2 + temp.y**2 + temp.z**2);
  const ey = { x: temp.x/dTemp, y: temp.y/dTemp, z: temp.z/dTemp };
  
  const ez = { 
    x: ex.y*ey.z - ex.z*ey.y, 
    y: ex.z*ey.x - ex.x*ey.z, 
    z: ex.x*ey.y - ex.y*ey.x 
  };

  const d = Math.sqrt(v21.x**2 + v21.y**2 + v21.z**2); 
  const j = ey.x*v31.x + ey.y*v31.y + ey.z*v31.z;

  const x = (r**2 - r**2 + d**2) / (2*d);
  const y = (r**2 - r**2 + i**2 + j**2) / (2*j) - (i/j)*x;

  const zSq = r**2 - x**2 - y**2;
  
  if (zSq < 0) return null; 

  const zWristLocal = -Math.sqrt(zSq); 

  const wristPos = {
    x: p1.x + x*ex.x + y*ey.x + zWristLocal*ez.x,
    y: p1.y + x*ex.y + y*ey.y + zWristLocal*ez.y,
    z: p1.z + x*ex.z + y*ey.z + zWristLocal*ez.z
  };

  // Convert Wrist Position back to Tip Position
  return {
    x: wristPos.x,
    y: wristPos.y,
    z: wristPos.z - nozzleLength
  };
};

// --- MOTOR SIMULATION ---
export const simulateMotorQuantization = (
  idealAngles: MotorAngles, 
  mode: 'NEMA17' | 'SERVO_MG995'
): [number, number, number] => {
  if (!idealAngles.isValid) return [0,0,0];

  const { theta1, theta2, theta3 } = idealAngles;
  const raw = [theta1, theta2, theta3];

  if (mode === 'NEMA17') {
    // 1/16 microstepping = 0.1125 deg step
    const stepSize = 1.8 / 16;
    return raw.map(a => Math.round(a / stepSize) * stepSize) as [number, number, number];
  } else {
    // Servo Simulation: Coarse steps + Noise
    const stepSize = 0.45; 
    const jitter = (Math.random() - 0.5) * 0.8; // Increased jitter for visibility
    return raw.map(a => (Math.round(a / stepSize) * stepSize) + jitter) as [number, number, number];
  }
};

export const calculateVolumeMetrics = (specs: RobotSpecs): CalculationResult => {
  const stepAngle = 1.8;
  const microsteps = specs.microstepping;
  const angularResRad = (stepAngle / microsteps) * (Math.PI / 180);
  const linearRes = angularResRad * specs.bicepLength; 
  const scaleFactor = (specs.bicepLength + specs.forearmLength) / (127 + 254);
  const baseVolumeWidth = 184.05 * scaleFactor;
  const baseVolumeHeight = 184.05 * scaleFactor;

  return {
    resolution: parseFloat(linearRes.toFixed(3)),
    maxWidth: parseFloat(baseVolumeWidth.toFixed(2)),
    maxHeight: parseFloat(baseVolumeHeight.toFixed(2)),
    maxVolume: parseFloat((baseVolumeWidth * baseVolumeWidth * baseVolumeHeight).toFixed(0))
  };
};

// --- HELPERS FOR PATH PROCESSING ---

export const sortPointsForPath = (points: Position[]): Position[] => {
  // 1. Bucket by Z level (approximate to 0.1mm)
  const layers: Record<string, Position[]> = {};
  points.forEach(p => {
    const zKey = p.z.toFixed(1);
    if (!layers[zKey]) layers[zKey] = [];
    layers[zKey].push(p);
  });

  // 2. Sort layers bottom up
  const sortedLevels = Object.keys(layers).sort((a, b) => parseFloat(a) - parseFloat(b));
  
  const optimizedPath: Position[] = [];
  let currentPos = { x: 0, y: 0, z: -999 };

  sortedLevels.forEach(level => {
    let layerPoints = layers[level];
    
    // Greedy Nearest Neighbor sort for this layer
    while(layerPoints.length > 0) {
      let nearestIdx = -1;
      let minDist = Infinity;
      
      for(let i=0; i<layerPoints.length; i++) {
        const p = layerPoints[i];
        const dist = Math.sqrt((p.x - currentPos.x)**2 + (p.y - currentPos.y)**2);
        if(dist < minDist) {
          minDist = dist;
          nearestIdx = i;
        }
      }
      
      if(nearestIdx !== -1) {
        currentPos = layerPoints[nearestIdx];
        optimizedPath.push(currentPos);
        layerPoints.splice(nearestIdx, 1);
      }
    }
  });

  return optimizedPath;
};

export const calculatePrintStats = (path: Position[], mode: 'NEMA17' | 'SERVO_MG995') => {
  let totalDist = 0;
  for(let i=1; i<path.length; i++) {
    const p1 = path[i-1];
    const p2 = path[i];
    totalDist += Math.sqrt((p2.x-p1.x)**2 + (p2.y-p1.y)**2 + (p2.z-p1.z)**2);
  }

  const speed = mode === 'NEMA17' ? 40 : 80; 
  
  const timeSeconds = totalDist / speed;
  
  return {
    distance: totalDist,
    timeSeconds: Math.ceil(timeSeconds),
    speed
  };
};