export interface RobotSpecs {
  baseRadius: number;
  bicepLength: number; // rf
  forearmLength: number; // re
  effectorRadius: number;
  nozzleLength: number; // Vertical distance from wrist to tip
  motorType: 'NEMA17' | 'SERVO_MG995';
  microstepping: number; // e.g., 16
  orientation: 'standard' | 'upside-down';
}

export interface Position {
  x: number;
  y: number;
  z: number;
  e?: number; // Extrusion amount
  isTravel?: boolean; // True if G0 (non-printing)
}

export interface MotorAngles {
  theta1: number;
  theta2: number;
  theta3: number;
  isValid: boolean;
}

export interface CalculationResult {
  resolution: number; // mm per microstep approx
  maxVolume: number; // mm^3
  maxHeight: number; // mm
  maxWidth: number; // mm
}

export interface SimulationPath {
  original: Position[]; // The ideal path from G-code
  simulated: Position[]; // The path after motor quantization error
}

export interface ModelTransform {
  x: number;
  y: number;
  z: number; // Bed Z level offset
  scale: number;
  rotation: number;
}

export interface CostSettings {
  powerRating: number; // Watts (e.g. 350W)
  electricityCost: number; // $ per kWh
  filamentCost: number; // $ per kg
  filamentDensity: number; // g/cm3 (PLA ~1.24)
}

export interface GCodeParsed {
  points: Position[];
  totalTime: number; // seconds
  totalFilament: number; // mm
  boundingBox: { min: Position, max: Position };
}

export interface SlicerSettings {
  filamentDiameter: number;
  nozzleDiameter: number;
  layerHeight: number;
  temperature: number;
  travelSpeed: number;
  printSpeed: number;
}

export interface GCodeFile {
  name: string;
  lines: string[];
  totalTime: number;
  totalFilament: number;
}