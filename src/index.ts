import { argType,TypeOfAdd } from "./types/types";
export default class RankingAlgorithm {

    constructor(public stretch:number,public startValue:number,public config:argType[]){

    }
    time(t:number):number{
        const expo:number = -(t/this.stretch);
        const exp:number = Math.exp(expo);
        return 1 -exp+this.startValue;
    }
    calc(...sumProps:any):number{
        let total: number=0;
        let i:number=0;
        for (const config of this.config) {
            if (config.valuable === true) {
                const refarg = this.config.find((arg) => arg.ref === this.config[i].field);
                const refargIndex = this.config.findIndex((arg) => arg.ref === this.config[i].field);
                if (refargIndex !== -1) {
                    switch (config.typeOfAdd) {
                        case "Sum": {
                            total = total + (sumProps[i] + sumProps[refargIndex]);
                            break;
                        }
                        case "Multiplication": {
                            total = total + (sumProps[i] * sumProps[refargIndex]);
                            break;
                        }
                    }
                }else{
                    total = total + sumProps[i];
                }
                
            }
            else {
                total = total + sumProps[i];
            }
            i++;
        }
        const lastResult:number = total/this.time(sumProps[sumProps.length-1]);
        return lastResult;
    }

}

