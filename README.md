
# Ranking algorithm

This algorithm is helpful when building your own e-commerce website, a social media app or any app that users can post something.
He gives a score to each post based upon the parameters you give him and the time(t) 


## Badges



[![MIT License](https://img.shields.io/apm/l/atomic-design-ui.svg?)](https://github.com/tterb/atomic-design-ui/blob/master/LICENSEs)

## Author

- [@youssefmahersi](https://github.com/youssefmahersi)


## Installation

How to install the algorithm

```bash
  npm install --save rannkingalgorithm

```
    
## Usage
typescript
```typescript
import { RankingAlgorithm } from "rankingalgorithm";

const rankingAlgo = new RankingAlgorithm(stretch,startValue,[{
    field:"propName",
    valuable:Boolean,//if this property is valuable then it's true
    typeOfAdd : "Sum"||"Multiplication",
    ref:""
},
{
    field:"propName",
    valuable:false,
    typeOfAdd : "",
    ref:"propName"//when puting propName this prop will be added to the property you refered to
}])

console.log(rankingAlgo.calc(propName1Value,propName2Value,t));//A score
```

Nodejs

```javascript
const { RankingAlgorithm }= require("rankingalgorithm");

const rankingAlgo = new RankingAlgorithm(stretch,startValue,[{
    field:"propName",
    valuable:Boolean,//if this property is valuable then it's true
    typeOfAdd : "Sum"||"Multiplication",
    ref:""
},
{
    field:"propName",
    valuable:false,
    typeOfAdd : "",
    ref:"propName"//when puting propName this prop will be added to the property you refered to
}])

console.log(rankingAlgo.calc(propName1Value,propName2Value,t));//A score
```




## Documentation

![Math equation](https://i.postimg.cc/Ghctx4Br/matheq2.png)

This algorithm was built to help each app that users can post anything, to give it a score 
based upon properties you give it to him and time variation.

# Numerator 
In the Numerator you can put your own propreties(number of likes, number of comments, audience...)
and if you have something valuable you can play with it. 

ex:
if we have parameters like (nLikes,ncomments,audience)
we want to multiplie the audience with the nLikes to make it more valuable something   
(Nlikes*audience+ncomments+audience)
in the code we must put :

{
    field:"nLikes",
    valuable:true,
    typeOfAdd :"Multiplication",
    ref:""
},

{
    field:"audience",
    valuable:false,
    typeOfAdd : "",
    ref:"nLikes"
},

{
   field:"ncomments",
    valuable:false,
    typeOfAdd : "",
    ref:""
}

NW: When giving the values of parameters you must ordre the values correctly when you want to add ref to a property it must be in order after the main property

ex : console.log(rankingAlgo.calc(nLikes,audience,ncomments,t));

# Denominator
the goal of this function is to start from a value near to zero then it goes up until it will be constant 
In the denominator the function above is an exponential function that starts at t=0s with the (StartValue)that you specifie for better results you must specifie a number close to 0 , so the score in the beginning can be too high so the post can be ranked at the top and get a higher chance to be viewed more than old posts 
after a period of time this function will go up so the post will be classed in the medieum giving the chance to other posts to be classed at the top 

the stretch : 
it's used to play with equation to be more stretched when you want the equation to be constatnt very quick you must give it a small number

stretch(high) -> long time to reach the stability

stretch(low) -> short time to reach the stability

this exemple explains more the stretch with startValue=0,0002 

![App Screenshot](https://i.postimg.cc/63R403mx/Screenshot-37.png)


f(x) with stretch = 8,g(x) with stretch = 4,d(x) with stretch = 16


# Conclusion

The algorithm will output a score each minute t=0.01 with the time variation 






## Demo

https://drive.google.com/file/d/13Zflm3AEUlVK8S_MWOPW1PcNg_HkQqiy/view?usp=sharing