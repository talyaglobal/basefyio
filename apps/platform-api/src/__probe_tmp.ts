import * as Papa from 'papaparse';
import * as XLSX from 'xlsx';
export const a = Papa.unparse([{ x: 1 }]);
export const b = XLSX.utils.json_to_sheet([{ x: 1 }]);
