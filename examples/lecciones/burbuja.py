xs = [5, 3, 8, 1, 9, 2]
n = len(xs)
for i in range(n):
    for j in range(n - 1 - i):
        if xs[j] > xs[j + 1]:
            xs[j], xs[j + 1] = xs[j + 1], xs[j]
print(xs)
