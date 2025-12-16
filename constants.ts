import { RobotSpecs, CostSettings } from './types';

export const DEFAULT_SPECS: RobotSpecs = {
  baseRadius: 60,
  bicepLength: 127,
  forearmLength: 254,
  effectorRadius: 38,
  nozzleLength: 40,
  motorType: 'NEMA17',
  microstepping: 16,
  orientation: 'standard'
};

export const DEFAULT_COST_SETTINGS: CostSettings = {
  powerRating: 350, // Standard PSU wattage
  electricityCost: 0.15, // $0.15 per kWh
  filamentCost: 20.0, // $20 per kg
  filamentDensity: 1.24 // PLA
};

export const INITIAL_POSITION = { x: 0, y: 0, z: -250 };

export const MOTOR_OFFSET_ANGLES = [0, 120, 240]; // Degrees around the center