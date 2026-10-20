import type { FormatInput, FormatResult } from '../../../shared/formats/types';

export interface ParseRequest {
  id: number;
  input: FormatInput;
}

export interface ParseResponse {
  id: number;
  result: FormatResult;
}
