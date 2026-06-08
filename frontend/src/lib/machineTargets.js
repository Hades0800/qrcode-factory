// 各機台每日工時目標（分鐘）— 對應原 utils.js
export const MACHINE_TARGETS = {
  'No1-350': { workMinutes: 280, prepMinutes: 200, capacityKg: 10000 },
  'No2-250': { workMinutes: 210, prepMinutes: 270, capacityKg: 1800 },
  'No3-60':  { workMinutes: 320, prepMinutes: 160, capacityKg: 1200 },
  'No4-90':  { workMinutes: 320, prepMinutes: 160, capacityKg: 1200 },
  'No5-40':  { workMinutes: 420, prepMinutes: 60,  capacityKg: 500 },
  'No6-40':  { workMinutes: 420, prepMinutes: 60,  capacityKg: 500 },
};

export const MACHINES = [
  { id: 'No1-350', num: 'No1', spec: '350' },
  { id: 'No2-250', num: 'No2', spec: '250' },
  { id: 'No3-60',  num: 'No3', spec: '60' },
  { id: 'No4-90',  num: 'No4', spec: '90' },
  { id: 'No5-40',  num: 'No5', spec: '40' },
  { id: 'No6-40',  num: 'No6', spec: '40' },
];

export const ALLOWED_MACHINES = new Set(MACHINES.map(m => m.id));

export const AUX_EQUIPMENT_LABELS = {
  flat: '軋平機',
  leveler: '整平機',
  slitter: '分條機',
  wave: '波浪機',
  rewind: '收料機',
  other: '其他設備',
};
