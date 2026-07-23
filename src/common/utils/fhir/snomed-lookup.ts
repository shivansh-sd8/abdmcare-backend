export interface SnomedEntry {
  code: string;
  display: string;
  system: string;
}

const SNOMED_SYSTEM = 'http://snomed.info/sct';

function entry(code: string, display: string): SnomedEntry {
  return { code, display, system: SNOMED_SYSTEM };
}

// ─── Common Diagnoses ─────────────────────────────────────────────────────────

const SNOMED_TABLE: Record<string, SnomedEntry> = {
  // Metabolic / Endocrine
  'diabetes mellitus': entry('73211009', 'Diabetes mellitus'),
  'type 2 diabetes': entry('44054006', 'Type 2 diabetes mellitus'),
  'type 1 diabetes': entry('46635009', 'Type 1 diabetes mellitus'),
  'diabetic ketoacidosis': entry('420422005', 'Diabetic ketoacidosis'),
  'hypothyroidism': entry('40930008', 'Hypothyroidism'),
  'hyperthyroidism': entry('34486009', 'Hyperthyroidism'),
  'obesity': entry('414916001', 'Obesity'),
  'hyperlipidemia': entry('55822004', 'Hyperlipidemia'),
  'dyslipidemia': entry('370992007', 'Dyslipidemia'),

  // Cardiovascular
  'hypertension': entry('38341003', 'Hypertensive disorder'),
  'essential hypertension': entry('59621000', 'Essential hypertension'),
  'coronary artery disease': entry('53741008', 'Coronary arteriosclerosis'),
  'myocardial infarction': entry('22298006', 'Myocardial infarction'),
  'heart failure': entry('84114007', 'Heart failure'),
  'congestive heart failure': entry('42343007', 'Congestive heart failure'),
  'atrial fibrillation': entry('49436004', 'Atrial fibrillation'),
  'deep vein thrombosis': entry('128053003', 'Deep venous thrombosis'),
  'pulmonary embolism': entry('59282003', 'Pulmonary embolism'),
  'stroke': entry('230690007', 'Cerebrovascular accident'),
  'angina': entry('194828000', 'Angina pectoris'),

  // Respiratory
  'asthma': entry('195967001', 'Asthma'),
  'bronchial asthma': entry('195967001', 'Asthma'),
  'copd': entry('13645005', 'Chronic obstructive lung disease'),
  'pneumonia': entry('233604007', 'Pneumonia'),
  'tuberculosis': entry('56717001', 'Tuberculosis'),
  'pulmonary tuberculosis': entry('154283005', 'Pulmonary tuberculosis'),
  'bronchitis': entry('32398004', 'Bronchitis'),
  'acute bronchitis': entry('10509002', 'Acute bronchitis'),
  'upper respiratory infection': entry('54150009', 'Upper respiratory infection'),
  'pleural effusion': entry('60046008', 'Pleural effusion'),
  'pneumothorax': entry('36118008', 'Pneumothorax'),

  // Infectious Diseases (Indian context)
  'dengue': entry('38362002', 'Dengue'),
  'dengue fever': entry('38362002', 'Dengue'),
  'malaria': entry('61462000', 'Malaria'),
  'typhoid': entry('4834000', 'Typhoid fever'),
  'typhoid fever': entry('4834000', 'Typhoid fever'),
  'chikungunya': entry('111864006', 'Chikungunya fever'),
  'cholera': entry('63650001', 'Cholera'),
  'leptospirosis': entry('77377001', 'Leptospirosis'),
  'hepatitis a': entry('40468003', 'Viral hepatitis, type A'),
  'hepatitis b': entry('66071002', 'Viral hepatitis, type B'),
  'hepatitis c': entry('50711007', 'Viral hepatitis, type C'),
  'hiv': entry('86406008', 'Human immunodeficiency virus infection'),
  'covid-19': entry('840539006', 'Disease caused by SARS-CoV-2'),
  'chickenpox': entry('38907003', 'Varicella'),
  'measles': entry('14189004', 'Measles'),
  'mumps': entry('36989005', 'Mumps'),

  // Gastrointestinal
  'gastritis': entry('4556007', 'Gastritis'),
  'gastroenteritis': entry('25374005', 'Gastroenteritis'),
  'peptic ulcer': entry('13200003', 'Peptic ulcer'),
  'gerd': entry('235595009', 'Gastroesophageal reflux disease'),
  'acid reflux': entry('235595009', 'Gastroesophageal reflux disease'),
  'appendicitis': entry('74400008', 'Appendicitis'),
  'acute appendicitis': entry('85189001', 'Acute appendicitis'),
  'jaundice': entry('18165001', 'Jaundice'),
  'cirrhosis': entry('19943007', 'Cirrhosis of liver'),
  'fatty liver': entry('197321007', 'Steatosis of liver'),
  'pancreatitis': entry('75694006', 'Pancreatitis'),
  'intestinal obstruction': entry('81060008', 'Intestinal obstruction'),
  'diarrhea': entry('62315008', 'Diarrhea'),
  'constipation': entry('14760008', 'Constipation'),
  'dyspepsia': entry('162031009', 'Dyspepsia'),

  // Renal / Urological
  'urinary tract infection': entry('68566005', 'Urinary tract infection'),
  'uti': entry('68566005', 'Urinary tract infection'),
  'chronic kidney disease': entry('709044004', 'Chronic kidney disease'),
  'acute kidney injury': entry('14669001', 'Acute renal failure'),
  'kidney stone': entry('95570007', 'Kidney stone'),
  'nephrolithiasis': entry('95570007', 'Kidney stone'),

  // Hematological
  'anemia': entry('271737000', 'Anemia'),
  'iron deficiency anemia': entry('87522002', 'Iron deficiency anemia'),
  'sickle cell disease': entry('417357006', 'Sickle cell disease'),
  'thalassemia': entry('40108008', 'Thalassemia'),
  'thrombocytopenia': entry('302215000', 'Thrombocytopenic disorder'),

  // Neurological
  'migraine': entry('37796009', 'Migraine'),
  'epilepsy': entry('84757009', 'Epilepsy'),
  'seizure': entry('91175000', 'Seizure'),
  'meningitis': entry('7180009', 'Meningitis'),
  'cerebral palsy': entry('128188000', 'Cerebral palsy'),

  // Musculoskeletal
  'osteoarthritis': entry('396275006', 'Osteoarthritis'),
  'rheumatoid arthritis': entry('69896004', 'Rheumatoid arthritis'),
  'low back pain': entry('279039007', 'Low back pain'),
  'fracture': entry('125605004', 'Fracture of bone'),
  'osteoporosis': entry('64859006', 'Osteoporosis'),

  // Dermatological
  'dermatitis': entry('182782007', 'Dermatitis'),
  'eczema': entry('43116000', 'Eczema'),
  'psoriasis': entry('9014002', 'Psoriasis'),
  'scabies': entry('128869009', 'Scabies'),
  'fungal infection': entry('3218000', 'Mycosis'),
  'cellulitis': entry('128045006', 'Cellulitis'),

  // Symptoms
  'fever': entry('386661006', 'Fever'),
  'cough': entry('49727002', 'Cough'),
  'headache': entry('25064002', 'Headache'),
  'chest pain': entry('29857009', 'Chest pain'),
  'breathlessness': entry('267036007', 'Dyspnea'),
  'dyspnea': entry('267036007', 'Dyspnea'),
  'abdominal pain': entry('21522001', 'Abdominal pain'),
  'vomiting': entry('422400008', 'Vomiting'),
  'nausea': entry('422587007', 'Nausea'),
  'dizziness': entry('404640003', 'Dizziness'),
  'fatigue': entry('84229001', 'Fatigue'),
  'weight loss': entry('89362005', 'Weight loss'),
  'edema': entry('267038008', 'Edema'),
  'palpitations': entry('80313002', 'Palpitations'),
  'syncope': entry('271594007', 'Syncope'),

  // Common Procedures
  'appendectomy': entry('80146002', 'Appendectomy'),
  'caesarean section': entry('11466000', 'Cesarean section'),
  'endoscopy': entry('423827005', 'Endoscopy'),
  'colonoscopy': entry('73761001', 'Colonoscopy'),
  'cholecystectomy': entry('38102005', 'Cholecystectomy'),
  'hernia repair': entry('44946007', 'Repair of hernia'),
  'hysterectomy': entry('236886002', 'Hysterectomy'),
  'dialysis': entry('108241001', 'Dialysis procedure'),
  'blood transfusion': entry('116859006', 'Transfusion of blood product'),
  'catheterization': entry('45211000', 'Catheterization'),
  'intubation': entry('112798008', 'Intubation'),
  'biopsy': entry('86273004', 'Biopsy'),
  'suturing': entry('18557009', 'Suture of skin'),

  // Body Sites
  'chest': entry('51185008', 'Thorax structure'),
  'abdomen': entry('818983003', 'Abdomen'),
  'head': entry('69536005', 'Head structure'),
  'neck': entry('45048000', 'Neck structure'),
  'upper limb': entry('53120007', 'Upper limb structure'),
  'lower limb': entry('61685007', 'Lower limb structure'),
  'spine': entry('421060004', 'Vertebral column structure'),
  'pelvis': entry('12921003', 'Pelvis structure'),
  'liver': entry('10200004', 'Liver structure'),
  'kidney': entry('64033007', 'Kidney structure'),
  'lung': entry('39607008', 'Lung structure'),
  'heart': entry('80891009', 'Heart structure'),
  'brain': entry('12738006', 'Brain structure'),
  'eye': entry('81745001', 'Eye structure'),
  'ear': entry('117590005', 'Ear structure'),
  'skin': entry('39937001', 'Skin structure'),

  // Indian hospital common conditions
  'tb': entry('56717001', 'Tuberculosis'),
  'filariasis': entry('77506005', 'Filariasis'),
  'kala azar': entry('10929004', 'Leishmaniasis'),
  'leishmaniasis': entry('10929004', 'Leishmaniasis'),
  'snakebite': entry('238456006', 'Venomous snakebite'),
  'scorpion sting': entry('424570007', 'Scorpion sting'),
  'heat stroke': entry('52072009', 'Heat stroke'),
  'dehydration': entry('34095006', 'Dehydration'),
  'malnutrition': entry('248325000', 'Malnutrition'),
  'vitamin d deficiency': entry('34713006', 'Vitamin D deficiency'),
  'rickets': entry('4109002', 'Rickets'),
};

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Fuzzy keyword match: checks if any key in the SNOMED table is a substring
 * of the normalized term, or vice versa.
 */
export function lookupSnomed(term: string): SnomedEntry | undefined {
  if (!term) return undefined;

  const normalized = normalize(term);

  // Exact match first
  if (SNOMED_TABLE[normalized]) {
    return SNOMED_TABLE[normalized];
  }

  // Check if any key is a substring of the input or input is a substring of a key
  for (const [key, entry] of Object.entries(SNOMED_TABLE)) {
    const normKey = normalize(key);
    if (normalized.includes(normKey) || normKey.includes(normalized)) {
      return entry;
    }
  }

  return undefined;
}

/**
 * Look up multiple terms and return all matches.
 */
export function lookupSnomedBatch(terms: string[]): Map<string, SnomedEntry> {
  const results = new Map<string, SnomedEntry>();
  for (const term of terms) {
    const match = lookupSnomed(term);
    if (match) {
      results.set(term, match);
    }
  }
  return results;
}
