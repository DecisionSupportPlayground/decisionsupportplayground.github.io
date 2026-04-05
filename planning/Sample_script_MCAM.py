# -*- coding: utf-8 -*-
"""
"""
# Importing the Libraries
import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from pymcdm import weights as w
from pymcdm.methods import TOPSIS, MABAC, ARAS, SAW, WSM
from pymcdm.helpers import rrankdata
from pymcdm import visuals
"""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
                              CODE
"""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""

############    clearing console    ###############################
print("\033[H\033[J")
#######    end clearing console    ###############################


#######-------------    Input data    ------------- #######

# Define decision matrix (xx alternatives, yy criteria) by reading a csv file

df = pd.read_csv('data.csv')
# Use only columns with numerical data
alts = df[df.columns[1:]].to_numpy()
print(alts)

#to see the data in the csv file uncomment the next line
#print(df)

# Define weights and types
weights = w.equal_weights(alts)
#weights = np.array([0.33, 0.2, 0.13, 0.07, 0.27])
types = np.array([1, -1, -1, -1, 1])    # cost or benefit atributes

methods = [
    TOPSIS(),
    SAW()
]

method_names = ['TOPSIS','SAW']


# Determine preferences and ranking for alternatives
prefs = []
ranks = []

for method in methods:
    pref = method(alts, weights, types)
    rank = rrankdata(pref)
    
    prefs.append(pref)
    ranks.append(rank)

# printing results
a = [f'A{{{i+1}}}' for i in range(len(prefs[0]))]
print('Preference table/ method \n')
print(pd.DataFrame(zip(*prefs), columns=method_names, index=a).round(2))
print('\n Ranking of alternatives / method \n')
print(pd.DataFrame(zip(*ranks), columns=method_names, index=a).astype('int'))


#different figures
#fig, ax = plt.subplots(figsize=(7, 3), dpi=150, tight_layout=True)
#visuals.ranking_bar(ranks, labels=method_names, ax=ax)
#plt.show()
#
fig, ax = plt.subplots(figsize=(7, 7), dpi=150, tight_layout=True, subplot_kw=dict(projection='polar'))
visuals.polar_plot(ranks, labels=method_names,legend_ncol=2, ax=ax)
plt.show()

