export type LedRepairableIssue = {
  qty:number;problem_type:string;stock_quantity:number;repaired_quantity:number;
};
export function tracksLedStock(issue:Pick<LedRepairableIssue,"problem_type">){
  return !["damaged_housing","hub_card_problem"].includes(issue.problem_type);
}
export function ledIssueRemaining(issue:LedRepairableIssue){
  return Math.max(0,tracksLedStock(issue)?Number(issue.stock_quantity)||0:
    (Number(issue.qty)||0)-(Number(issue.repaired_quantity)||0));
}
export function ledIssueRepairLabel(issue:LedRepairableIssue){
  const pending=ledIssueRemaining(issue),repaired=Math.max(0,Number(issue.repaired_quantity)||0);
  if(pending===0)return repaired>0?"Repaired":"Stock cleared";
  return repaired>0?`Partially repaired · ${pending} remaining`:`${pending} awaiting repair`;
}
export function validLedRepairQuantity(quantity:number,remaining:number){
  return Number.isInteger(quantity)&&quantity>0&&quantity<=remaining;
}
