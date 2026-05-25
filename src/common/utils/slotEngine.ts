/**
 * Slot generation engine for dynamic hospital/doctor scheduling.
 *
 * Merge hierarchy: doctor overrides → hospital config → system defaults.
 * Handles operating hours, breaks, holidays, 24/7 mode, and booked-slot subtraction.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DayHours {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
}

export interface BreakTime {
  start: string; // "HH:MM"
  end: string;   // "HH:MM"
  label?: string;
}

export type WeeklySchedule = {
  [day in 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun']?: DayHours | null;
};

export interface HospitalScheduleConfig {
  operatingHours?: WeeklySchedule | null;
  defaultSlotDuration?: number;
  breakTimes?: BreakTime[] | null;
  holidays?: string[] | null; // ISO date strings
  is24x7?: boolean;
}

export interface DoctorScheduleConfig {
  workingHours?: WeeklySchedule | null;
  slotDuration?: number | null;
  maxPatientsPerDay?: number;
  breakTimes?: BreakTime[] | null;
}

export interface SlotGenerationResult {
  available: string[];       // available "HH:MM" strings
  booked: string[];          // booked "HH:MM" strings
  allSlots: string[];        // all generated slots before filtering
  slotDuration: number;
  isHoliday: boolean;
  isClosed: boolean;
  maxPatientsPerDay: number;
  capacityReached: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SYSTEM_DEFAULT_HOURS: WeeklySchedule = {
  mon: { start: '09:00', end: '21:00' },
  tue: { start: '09:00', end: '21:00' },
  wed: { start: '09:00', end: '21:00' },
  thu: { start: '09:00', end: '21:00' },
  fri: { start: '09:00', end: '21:00' },
  sat: { start: '09:00', end: '17:00' },
  sun: { start: '09:00', end: '14:00' },
};

const ALL_DAY: DayHours = { start: '00:00', end: '23:59' };
const DEFAULT_SLOT_DURATION = 30;
const DEFAULT_MAX_PATIENTS = 30;

const DAY_KEYS: (keyof WeeklySchedule)[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getDayKey(date: Date): keyof WeeklySchedule {
  return DAY_KEYS[date.getDay()];
}

function isInBreak(slotMinutes: number, breaks: BreakTime[]): boolean {
  return breaks.some(b => {
    const bStart = toMinutes(b.start);
    const bEnd = toMinutes(b.end);
    return slotMinutes >= bStart && slotMinutes < bEnd;
  });
}

// ─── Main Engine ─────────────────────────────────────────────────────────────

export function generateSlots(
  date: Date,
  hospital: HospitalScheduleConfig,
  doctor: DoctorScheduleConfig,
  bookedTimes: string[],  // already-booked "HH:MM" strings for this doctor+date
  now?: Date,             // for filtering past slots (defaults to current time)
): SlotGenerationResult {
  const currentTime = now || new Date();
  const isToday = date.toDateString() === currentTime.toDateString();

  // 1. Check holidays
  const dateStr = date.toISOString().split('T')[0];
  const holidays = (hospital.holidays as string[] | null) || [];
  const isHoliday = holidays.includes(dateStr);
  if (isHoliday) {
    return { available: [], booked: [], allSlots: [], slotDuration: 0, isHoliday: true, isClosed: false, maxPatientsPerDay: 0, capacityReached: false };
  }

  // 2. Resolve effective hours for this day of week
  const dayKey = getDayKey(date);
  let dayHours: DayHours | null | undefined;

  if (hospital.is24x7) {
    dayHours = ALL_DAY;
  }

  // Doctor overrides hospital if set
  const doctorHours = doctor.workingHours as WeeklySchedule | null;
  const hospitalHours = hospital.operatingHours as WeeklySchedule | null;

  if (doctorHours && dayKey in doctorHours) {
    dayHours = doctorHours[dayKey];
  } else if (hospital.is24x7) {
    // already set above
  } else if (hospitalHours && dayKey in hospitalHours) {
    dayHours = hospitalHours[dayKey];
  } else if (!hospitalHours && !doctorHours) {
    dayHours = SYSTEM_DEFAULT_HOURS[dayKey];
  } else {
    dayHours = SYSTEM_DEFAULT_HOURS[dayKey];
  }

  if (!dayHours) {
    return { available: [], booked: [], allSlots: [], slotDuration: 0, isHoliday: false, isClosed: true, maxPatientsPerDay: 0, capacityReached: false };
  }

  // 3. Resolve slot duration and max patients
  const slotDuration = doctor.slotDuration || hospital.defaultSlotDuration || DEFAULT_SLOT_DURATION;
  const maxPatientsPerDay = doctor.maxPatientsPerDay || DEFAULT_MAX_PATIENTS;

  // 4. Merge break times (hospital + doctor)
  const hospitalBreaks = (hospital.breakTimes as BreakTime[] | null) || [];
  const doctorBreaks = (doctor.breakTimes as BreakTime[] | null) || [];
  const allBreaks = [...hospitalBreaks, ...doctorBreaks];

  // 5. Generate all slots
  const startMin = toMinutes(dayHours.start);
  const endMin = toMinutes(dayHours.end);
  const allSlots: string[] = [];

  for (let t = startMin; t + slotDuration <= endMin + 1; t += slotDuration) {
    const slotStr = toHHMM(t);
    if (!isInBreak(t, allBreaks)) {
      allSlots.push(slotStr);
    }
  }

  // 6. Build booked set
  const bookedSet = new Set(bookedTimes);
  const booked = allSlots.filter(s => bookedSet.has(s));

  // 7. Check capacity
  const bookedCount = bookedTimes.length;
  const capacityReached = bookedCount >= maxPatientsPerDay;

  // 8. Filter available slots
  let available = allSlots.filter(s => !bookedSet.has(s));

  // 9. If today, filter past times
  if (isToday) {
    const currentMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();
    available = available.filter(s => toMinutes(s) > currentMinutes);
  }

  // 10. If capacity reached, no available slots
  if (capacityReached) {
    available = [];
  }

  return {
    available,
    booked,
    allSlots,
    slotDuration,
    isHoliday: false,
    isClosed: false,
    maxPatientsPerDay,
    capacityReached,
  };
}

/**
 * Check if a specific time falls within a valid slot for the given schedule.
 */
export function isValidSlotTime(
  time: string,
  date: Date,
  hospital: HospitalScheduleConfig,
  doctor: DoctorScheduleConfig,
): boolean {
  const result = generateSlots(date, hospital, doctor, [], new Date(0));
  return result.allSlots.includes(time);
}
