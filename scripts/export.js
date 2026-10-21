// Exporteert alle data (companies, websites, checks, meldingen) naar seed/seed.json.gz.
// Een nieuwe installatie met een lege database laadt die seed automatisch in.
import { exportSeed, SEED_FILE } from '../store.js';

const counts = exportSeed();
console.log(`Export klaar → ${SEED_FILE}`);
console.log(counts);
